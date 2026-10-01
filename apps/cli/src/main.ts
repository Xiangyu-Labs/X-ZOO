import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  callOperation,
  describeOperation,
  GUIDE,
  OperationError,
  searchOperations,
  uploadFile,
  type OpsClient,
} from '@shop/admin-ops';
import {
  normaliseOrigin,
  parseBody,
  parseLimit,
  parsePairs,
  UsageError,
  type ShopConfig,
} from './args';
import { clearConfig, loadConfig, saveConfig } from './config';
import { checkFreshness, DOWNLOAD_PATH } from './freshness';

/**
 * `shop` — the shop's admin API from a terminal, for a person or for an agent
 * driving a shell (Claude Code, Codex…). The same operations `/mcp` offers,
 * over the same token, through the same routes: permission checks and the
 * audit log apply exactly as in the console.
 *
 * Output is JSON on stdout. A call the server refused is still JSON on stdout
 * (`{ status, error }`, exit 1) so an agent can read what to fix; a usage
 * mistake or a request that never got an answer is a line on stderr (exit 2
 * and 1).
 */

const HELP = `shop — 用命令行管理商城

  shop login --origin https://x-zoo.vip --token -   保存地址和令牌（令牌从标准输入读，避免留在命令历史里）
  shop logout                                     删除本机保存的令牌（令牌本身要到后台撤销）
  shop whoami                                     当前身份和权限
  shop ops [关键词] [--domain 领域] [--limit N]    搜索可用的操作
  shop describe <操作id>                          参数说明和示例
  shop call <操作id> [--param k=v]... [--query k=v]... [--body JSON|@文件|@-]
  shop upload <本地文件> [--category 分类id] [--directory 目录]
  shop guide                                      常见任务怎么做

令牌在后台「设置 → API 令牌」新建。也可以用环境变量 SHOP_ORIGIN + SHOP_TOKEN（成对使用）。
最新版本：curl -o shop.js <商城地址>${DOWNLOAD_PATH}`;

const OPTIONS = {
  origin: { type: 'string' },
  token: { type: 'string' },
  domain: { type: 'string' },
  limit: { type: 'string' },
  param: { type: 'string', multiple: true, short: 'p' },
  query: { type: 'string', multiple: true, short: 'q' },
  body: { type: 'string', short: 'b' },
  category: { type: 'string' },
  directory: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsConfig['options'];

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Typed into a terminal: prompt and take one line. Piped in: read it all. */
async function readToken(): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question('粘贴令牌（shp_ 开头）后回车：');
  } finally {
    prompt.close();
  }
}

function readSource(source: string): Promise<string> {
  return source === '-' ? readStdin() : readFile(source, 'utf8');
}

const CALL_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** `fetch` that gives up: a stuck server must not hang the agent driving this. */
function fetchWithin(ms: number): typeof fetch {
  return (input, init) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) });
}

/** Started by the first command that talks to a shop; awaited before exit. */
let freshness: Promise<string | null> = Promise.resolve(null);

function connect(config: ShopConfig, timeoutMs = CALL_TIMEOUT_MS): OpsClient {
  freshness = checkFreshness(config.origin);
  return { ...config, fetch: fetchWithin(timeoutMs) };
}

async function client(timeoutMs?: number): Promise<OpsClient> {
  const config = await loadConfig();
  if (!config) throw new UsageError('还没登录：先运行 shop login --origin <商城地址> --token -');
  return connect(config, timeoutMs);
}

/** A failed call prints the server's answer (its message, its field problems) and exits 1. */
function finish(result: { ok: boolean; status: number; data: unknown }): number {
  print(result.ok ? result.data : { status: result.status, error: result.data });
  return result.ok ? 0 : 1;
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    print(HELP);
    return 0;
  }

  switch (command) {
    case 'login': {
      if (!values.origin || !values.token) {
        throw new UsageError('用法：shop login --origin https://x-zoo.vip --token -');
      }
      const origin = normaliseOrigin(values.origin);
      const token = (values.token === '-' ? await readToken() : values.token).trim();
      if (!token.startsWith('shp_')) throw new UsageError('令牌应以 shp_ 开头');
      const config = { origin, token };
      const me = await callOperation(connect(config), 'auth.adminMe');
      if (!me.ok) {
        print({ status: me.status, error: me.data });
        return 1;
      }
      const file = await saveConfig(config);
      print({ savedTo: file, me: me.data });
      return 0;
    }
    case 'logout':
      await clearConfig();
      print({
        loggedOut: true,
        note: '只删除了本机保存的令牌，令牌本身仍然有效；不再使用请到后台「设置 → API 令牌」撤销。',
      });
      return 0;
    case 'whoami':
      return finish(await callOperation(await client(), 'auth.adminMe'));
    case 'ops': {
      const limit = parseLimit(values.limit);
      print(
        searchOperations(rest.join(' '), {
          ...(limit === undefined ? {} : { limit }),
          ...(values.domain ? { domain: values.domain } : {}),
        }),
      );
      return 0;
    }
    case 'describe': {
      const [id] = rest;
      if (!id) throw new UsageError('用法：shop describe <操作id>');
      const detail = describeOperation(id);
      if (!detail) throw new UsageError(`没有这个操作：${id}。用 shop ops <关键词> 搜索。`);
      print(detail);
      return 0;
    }
    case 'call': {
      const [id] = rest;
      if (!id)
        throw new UsageError('用法：shop call <操作id> [--param k=v] [--query k=v] [--body JSON]');
      const body = await parseBody(values.body, readSource);
      return finish(
        await callOperation(await client(), id, {
          params: parsePairs(values.param, '--param'),
          query: parsePairs(values.query, '--query'),
          ...(body === undefined ? {} : { body }),
        }),
      );
    }
    case 'upload': {
      const [file] = rest;
      if (!file) throw new UsageError('用法：shop upload <本地文件> [--category 分类id]');
      return finish(
        await uploadFile(await client(UPLOAD_TIMEOUT_MS), {
          bytes: await readFile(file),
          filename: path.basename(file),
          ...(values.category ? { categoryId: values.category } : {}),
          ...(values.directory ? { directory: values.directory } : {}),
        }),
      );
    }
    case 'guide':
      print(GUIDE);
      return 0;
    default:
      throw new UsageError(`不认识的命令：${command}。运行 shop help 查看用法。`);
  }
}

/**
 * What went wrong, in words: `fetch failed` alone does not say whether the
 * address is wrong, the server is down or the certificate is bad.
 */
function explain(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return '请求超时：商城没有在规定时间内回答，稍后再试';
  }
  const text = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error ? (error.cause as { code?: string; message?: string }) : null;
  const detail = cause ? (cause.code ?? cause.message) : undefined;
  return detail ? `${text}（${detail}）` : text;
}

run(process.argv.slice(2))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const known = error instanceof UsageError || error instanceof OperationError;
      process.stderr.write(`${known ? explain(error) : `出错了：${explain(error)}`}\n`);
      process.exitCode = known ? 2 : 1;
    },
  )
  .then(() => freshness)
  .then((hint) => {
    if (hint) process.stderr.write(`${hint}\n`);
  });
