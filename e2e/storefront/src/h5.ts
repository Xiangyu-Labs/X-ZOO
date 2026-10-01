import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The H5 bundle `edge.ts` serves: the mini-program (`apps/mini`) built for H5
 * as "模拟小程序": `TARO_APP_PLATFORM_EMULATION=mp`, so it signs in with
 * `wx.login` codes and pays through `requestPayment` like the WeChat build,
 * answered by the harness (`gateway-control.ts`) instead of WeChat. Its own
 * output directory: the plain `build:h5` (the decoration preview) never
 * carries the emulation.
 *
 * Rebuilding on every run would cost time the suite does not need to pay when
 * nothing changed: the output is skipped when it is newer than every file the
 * build compiles.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..', '..');
const MINI_DIR = path.join(REPO_ROOT, 'apps', 'mini');
/** The directory the edge serves. */
export const H5_DIST_DIR = path.join(MINI_DIR, 'dist', 'h5-mp-emulation');
/** What the mini build compiles: the app, its config and the workspace sources it includes. */
const MINI_SOURCES = [
  path.join(MINI_DIR, 'src'),
  path.join(MINI_DIR, 'config'),
  path.join(MINI_DIR, 'babel.config.js'),
  path.join(MINI_DIR, 'package.json'),
  path.join(REPO_ROOT, 'packages', 'api-client', 'src'),
  path.join(REPO_ROOT, 'packages', 'contracts', 'src'),
  path.join(REPO_ROOT, 'packages', 'storefront-blocks', 'src'),
];

function newestMtimeMs(entry: string): number {
  const stats = statSync(entry, { throwIfNoEntry: false });
  if (!stats) return 0;
  if (stats.isFile()) return stats.mtimeMs;
  if (!stats.isDirectory()) return 0;
  let newest = stats.mtimeMs;
  for (const child of readdirSync(entry)) {
    newest = Math.max(newest, newestMtimeMs(path.join(entry, child)));
  }
  return newest;
}

function isDistFresh(distDir: string, sources: string[]): boolean {
  const marker = path.join(distDir, 'index.html');
  if (!existsSync(marker)) return false;
  const distMtime = statSync(marker).mtimeMs;
  const sourceMtime = Math.max(...sources.map(newestMtimeMs));
  return distMtime >= sourceMtime;
}

/**
 * Builds the H5 bundle if it is stale, otherwise does nothing.
 * Logs go to the parent's stdout/stderr so a CI run's build log shows them.
 */
export async function ensureH5Build(options: { log: (line: string) => void }): Promise<void> {
  if (isDistFresh(H5_DIST_DIR, MINI_SOURCES)) {
    options.log('h5: apps/mini/dist/h5-mp-emulation is up to date, skipping build');
    return;
  }
  options.log('h5: building apps/mini (pnpm run build:h5:mp-emulation)');
  // A production build whatever the caller's NODE_ENV: that is what ships.
  await run('pnpm', ['run', 'build:h5:mp-emulation'], MINI_DIR, options.log, {
    NODE_ENV: 'production',
  });
}

function run(
  command: string,
  args: string[],
  cwd: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) log(`h5: ${line}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) log(`h5: ${line}`);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
