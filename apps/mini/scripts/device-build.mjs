#!/usr/bin/env node
/**
 * The WeChat build for 微信开发者工具 and a real phone (docs/mini/device-check.md):
 *
 *   node scripts/device-build.mjs --origin http://192.168.1.20:4010
 *   node scripts/device-build.mjs --origin https://abc.trycloudflare.com [--appid wx…] [--mode …]
 *
 * It checks the AppID and the API origin, runs `taro build --type weapp --no-check` with them in
 * `TARO_APP_ID` / `TARO_APP_API_ORIGIN` (the shell wins over every `.env*` file), runs the size
 * and safety gate, and, when the origin is plain http, writes `dist/weapp/project.private.config.json`
 * with `urlCheck: false` so DevTools does not reject the requests. Nothing is committed and
 * nothing is sent anywhere: opening, previewing or uploading is done by hand in DevTools.
 *
 * - AppID: `--appid`, else `TARO_APP_ID`, else the shop's own mini-program, `wx4f4b772125e155ed`.
 * - Origin: `--origin`, else `TARO_APP_API_ORIGIN`, else `.env.<mode>.local`. Required: the build
 *   has no default origin. `https://` anywhere; `http://` only for a loopback or private LAN
 *   address (a phone accepts it only with 开发调试 on). Just scheme, host and port, no path.
 * - Mode: `--mode`, default `production` (what `build:weapp` builds, minified).
 *
 * The origin must be a local stack or a tunnel to one, never the production shop.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const appRoot = path.resolve(import.meta.dirname, '..');
const SHOP_APP_ID = 'wx4f4b772125e155ed';

const { values: args } = parseArgs({
  options: {
    origin: { type: 'string' },
    appid: { type: 'string' },
    mode: { type: 'string', default: 'production' },
    help: { type: 'boolean', default: false },
  },
});

function refuse(message) {
  console.error(`device-build: ${message}`);
  process.exit(1);
}

if (args.help) {
  console.log(
    'usage: node scripts/device-build.mjs --origin <http(s)://host:port> [--appid wx…] [--mode production|development]',
  );
  process.exit(0);
}

/** `KEY=value` from a dotenv file, quotes stripped; enough for the two keys read here. */
function readEnvFile(file, key) {
  if (!fs.existsSync(file)) return undefined;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw);
    if (match?.[1] === key) return match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return undefined;
}

if (!/^[a-z][a-z0-9-]*$/.test(args.mode)) refuse(`--mode ${args.mode} is not a Taro mode name`);
const localEnv = path.join(appRoot, `.env.${args.mode}.local`);

const appId = args.appid ?? process.env.TARO_APP_ID ?? SHOP_APP_ID;
if (!/^wx[0-9a-f]{16}$/.test(appId) && appId !== 'touristappid') {
  refuse(`${appId} is not a mini-program AppID (wx + 16 hex digits, or touristappid)`);
}

const rawOrigin =
  args.origin ?? process.env.TARO_APP_API_ORIGIN ?? readEnvFile(localEnv, 'TARO_APP_API_ORIGIN');
if (!rawOrigin) {
  refuse(
    `no API origin: pass --origin, or set TARO_APP_API_ORIGIN, or put it in ${path.relative(appRoot, localEnv)}`,
  );
}

let origin;
try {
  origin = new URL(rawOrigin);
} catch {
  refuse(`${rawOrigin} is not a URL`);
}
if (origin.pathname !== '/' || origin.search || origin.hash || origin.username) {
  refuse(`${rawOrigin}: give the origin only (scheme://host[:port]); the client adds /api/v1/…`);
}

/** Loopback, or an RFC 1918 private IPv4 address: where a plain-http dev stack may live. */
function isLocalHost(hostname) {
  if (hostname === 'localhost') return true;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const plainHttp = origin.protocol === 'http:';
if (plainHttp && !isLocalHost(origin.hostname)) {
  refuse(
    `${origin.origin}: plain http only for a loopback or private LAN address; use https for anything else`,
  );
}
if (!plainHttp && origin.protocol !== 'https:') refuse(`${origin.origin}: http or https only`);
if (origin.hostname === 'localhost' || origin.hostname.startsWith('127.')) {
  console.warn(
    `device-build: ${origin.origin} is this machine: DevTools' simulator can reach it, a phone cannot`,
  );
}

console.log(`device-build: AppID ${appId}, API ${origin.origin}, mode ${args.mode}`);

const env = { ...process.env, TARO_APP_ID: appId, TARO_APP_API_ORIGIN: origin.origin };
// Taro's own build script, as `build:weapp` runs it (`--no-check`: docs/mini/spikes/S1-taro.md).
const build = spawnSync(
  'pnpm',
  ['exec', 'taro', 'build', '--type', 'weapp', '--mode', args.mode, '--no-check'],
  { cwd: appRoot, env, stdio: 'inherit' },
);
if (build.status !== 0) refuse(`taro build failed (exit ${build.status ?? build.signal})`);

const dist = path.join(appRoot, 'dist/weapp');
const project = JSON.parse(fs.readFileSync(path.join(dist, 'project.config.json'), 'utf8'));
if (project.appid !== appId) {
  refuse(`dist/weapp/project.config.json has appid ${project.appid}, expected ${appId}`);
}

const privateConfig = path.join(dist, 'project.private.config.json');
if (plainHttp) {
  // DevTools overlays this file on project.config.json; it stays in dist/ (gitignored) and is
  // never uploaded. It is the same switch as 详情 → 本地设置 → 不校验合法域名….
  fs.writeFileSync(
    privateConfig,
    `${JSON.stringify(
      {
        description: 'scripts/device-build.mjs: a plain-http dev origin; local only',
        setting: { urlCheck: false },
      },
      null,
      2,
    )}\n`,
  );
} else if (fs.existsSync(privateConfig)) {
  fs.rmSync(privateConfig);
}

// The same environment as the build, so the stamp records the origin it was built for.
const size = spawnSync('node', [path.join(appRoot, 'scripts/size-report.mjs')], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
});
if (size.status !== 0) {
  // Nothing half-checked is left for DevTools to open or upload.
  fs.rmSync(dist, { recursive: true, force: true });
  refuse(
    'size-report failed, so dist/weapp was removed; fix it before putting this build on a phone',
  );
}

console.log(`
device-build: dist/weapp is ready.
  1. 微信开发者工具 → 导入项目 → 目录选 ${dist}，AppID ${appId}${
    appId === 'touristappid' ? '（游客模式，不能真机预览）' : ''
  }
  2. ${plainHttp ? '已关闭本地域名校验（project.private.config.json）；手机上预览后需打开「开发调试」' : 'https 源：手机上不开调试也能请求，但域名须在公众平台「服务器域名」里，否则也要开「开发调试」'}
  3. 按 docs/mini/device-check.md 逐项检查`);
