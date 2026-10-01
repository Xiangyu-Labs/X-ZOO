/**
 * The pure half of the CLI: turning `--param id=3 --query tag=a --query tag=b`
 * into the objects `callOperation` takes. No I/O here, so it is tested as is.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * `k=v` pairs into an object. A key given twice becomes an array — what a
 * repeated query key means to the server. Values stay strings: the routes
 * coerce query and path values themselves.
 */
export function parsePairs(
  pairs: readonly string[] | undefined,
  flag: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const pair of pairs ?? []) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`${flag} 需要 key=value 的形式，收到：${pair}`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const existing = out[key];
    out[key] =
      existing === undefined
        ? value
        : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return out;
}

/**
 * `--body` as given: inline JSON, `@path` for a file, `@-` for stdin. The
 * reader is passed in so this stays free of `fs`.
 */
export async function parseBody(
  raw: string | undefined,
  read: (source: string) => Promise<string>,
): Promise<unknown> {
  if (raw === undefined) return undefined;
  const text = raw.startsWith('@') ? await read(raw.slice(1)) : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`--body 不是合法的 JSON：${(error as Error).message}`);
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `https://x-zoo.vip/admin/` → `https://x-zoo.vip`. The token rides in every
 * request, so plain `http:` is only for a shop on this machine.
 */
export function normaliseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`不是合法的网址：${raw}`);
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new UsageError(`网址必须以 https:// 开头（http:// 只能用于本机）：${raw}`);
  }
  return url.origin;
}

/** `--limit`: a whole number from 1 up, or not given. */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new UsageError(`--limit 需要正整数，收到：${raw}`);
  }
  return limit;
}

export interface ShopConfig {
  origin: string;
  token: string;
}

/**
 * The saved login and `SHOP_ORIGIN` / `SHOP_TOKEN`, as one answer. The two
 * halves never mix across sources: an `SHOP_ORIGIN` pointing somewhere else
 * must not pick up the token saved for the real shop and send it there.
 */
export function resolveConfig(
  saved: Partial<ShopConfig> | null,
  env: { SHOP_ORIGIN?: string | undefined; SHOP_TOKEN?: string | undefined },
): ShopConfig | null {
  const envOrigin = env.SHOP_ORIGIN ? normaliseOrigin(env.SHOP_ORIGIN) : undefined;
  const savedOrigin = saved?.origin ? normaliseOrigin(saved.origin) : undefined;
  if (env.SHOP_TOKEN) {
    const origin = envOrigin ?? savedOrigin;
    if (!origin)
      throw new UsageError('设置了 SHOP_TOKEN，但没有 SHOP_ORIGIN，也没有登录过的商城地址');
    return { origin, token: env.SHOP_TOKEN };
  }
  if (envOrigin && envOrigin !== savedOrigin) {
    throw new UsageError(
      `SHOP_ORIGIN 是 ${envOrigin}，但保存的令牌属于 ${savedOrigin ?? '（没有）'}；请同时设置 SHOP_TOKEN`,
    );
  }
  return savedOrigin && saved?.token ? { origin: savedOrigin, token: saved.token } : null;
}
