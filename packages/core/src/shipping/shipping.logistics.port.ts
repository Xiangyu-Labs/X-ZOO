import type { Ctx } from '../kernel/context';
import {
  registerLogisticsPort,
  type LogisticsPort,
  type TrackingResult,
  type TrackingTrace,
} from '../order';
import { logisticsConfig } from '../system';
import { ALIYUN_SHUNFENG, aliyunExpressType } from './shipping.aliyun-codes';

/**
 * 物流跟踪, over 阿里云云市场's express API.
 *
 * Facts that shape this file:
 *
 *  - **the host is hardcoded.** It is not a setting, because a setting that
 *    names an outbound host is a way to exfiltrate the app code. Only the
 *    credential and the cache window are configurable (the `system` domain's
 *    `logisticsConfig`; shipping adds no second group).
 *  - **every call is cached in Redis** for `cacheMinutes` (default 30). The
 *    carriers rate-limit hard and the console polls: uncached, the tracking tab
 *    goes blank under load.
 *  - **a failure is never an exception.** A refused credential, a timeout or a
 *    carrier that has never heard of the number all come back as
 *    `state: 'unknown'` with no traces, because the caller is an operator
 *    looking at an order and a 500 tells them nothing.
 *  - **阿里云云市场 is the only provider.** The enum offers no provider that
 *    nothing implements, so `none` is the only other value and there is no
 *    warn-and-treat-as-`none` branch for a missing driver.
 *  - **our carrier codes are not the vendor's.** They are 快递100's
 *    (`yuantong`); `aliyunExpressType` translates, and a carrier it does not
 *    know is left for the vendor to recognise from the number.
 *
 * The client is tested against a fake `fetch`. Nothing here ever reaches a real
 * endpoint in a test or a build.
 */

const ALIYUN_HOST = 'https://wuliu.market.alicloudapi.com/kdi';
const TIMEOUT_MS = 5_000;

/** Injectable for tests. Never overridden in production code. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

export function setTrackingFetch(impl: FetchLike): void {
  fetchImpl = impl;
}

export function resetTrackingFetch(): void {
  fetchImpl = (url, init) => globalThis.fetch(url, init);
}

export const logisticsPort: LogisticsPort = {
  async track(ctx, input): Promise<TrackingResult> {
    const config = await ctx.config.get(logisticsConfig);
    if (config.provider !== 'aliyun-market' || config.appCode === '') return empty();

    const cacheKey = `shipping:tracking:${input.companyCode}:${input.trackingNo}`;
    const cached = await readCache(ctx, cacheKey);
    if (cached !== null) return cached;

    const result = await callAliyun(ctx, config.appCode, input);
    // A result nobody could parse is still worth caching briefly: a carrier
    // that does not know the number yet will not know it a second later either.
    await ctx.redis.set(cacheKey, JSON.stringify(result), 'EX', config.cacheMinutes * 60);
    return result;
  },
};

/** Idempotent; called from `index.ts` and safe to call again from a test. */
export function registerShippingLogisticsPort(): void {
  registerLogisticsPort(logisticsPort);
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

async function callAliyun(
  ctx: Ctx,
  appCode: string,
  input: { companyCode: string; trackingNo: string; phone?: string },
): Promise<TrackingResult> {
  const type = aliyunExpressType(input.companyCode);
  // The phone tail is 顺丰's requirement; another carrier's number with a
  // `:1234` stuck on it is a number the vendor has never seen.
  const phone = type === ALIYUN_SHUNFENG ? (input.phone ?? '') : '';
  const query = aliyunQuery({ trackingNo: input.trackingNo, type, phone });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ALIYUN_HOST}?${query.toString()}`, {
      method: 'GET',
      headers: { Authorization: `APPCODE ${appCode}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      ctx.logger.warn({ status: response.status }, '物流查询接口返回了非 200');
      return empty();
    }
    const payload = (await response.json()) as { status?: unknown; msg?: unknown };
    // The vendor's errors come with a 200. Without this line a wrong carrier
    // code and a parcel not yet scanned look the same: an empty tab, no trace.
    if (String(payload.status ?? '') !== '0') {
      ctx.logger.warn(
        { status: payload.status, msg: payload.msg, companyCode: input.companyCode, type },
        '物流查询没有结果',
      );
    }
    return parseAliyun(payload);
  } catch (error) {
    ctx.logger.warn({ err: error }, '物流查询失败');
    return empty();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `no` and `type` for `/kdi`. `type` absent lets the vendor guess the carrier;
 * a phone puts its last four digits after the number, which is how 顺丰 wants it.
 */
function aliyunQuery(input: {
  trackingNo: string;
  type: string | undefined;
  phone: string;
}): URLSearchParams {
  const no = input.phone === '' ? input.trackingNo : `${input.trackingNo}:${input.phone.slice(-4)}`;
  const query = new URLSearchParams({ no });
  if (input.type !== undefined) query.set('type', input.type);
  return query;
}

/**
 * `{ status: '0', result: { deliverystatus, list: [{ time, status }] } }`.
 *
 * Anything that does not look like that is an `unknown` with no traces — the
 * vendor answers errors with the same 200 and a different body.
 */
export function parseAliyun(payload: unknown): TrackingResult {
  if (typeof payload !== 'object' || payload === null) return empty();
  const body = payload as { status?: unknown; result?: unknown };
  if (String(body.status ?? '') !== '0') return empty();
  if (typeof body.result !== 'object' || body.result === null) return empty();
  const result = body.result as { deliverystatus?: unknown; list?: unknown };

  const traces: TrackingTrace[] = [];
  if (Array.isArray(result.list)) {
    for (const entry of result.list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const trace = entry as { time?: unknown; status?: unknown };
      const at = vendorTime(String(trace.time ?? ''));
      if (at === null) continue;
      traces.push({ at, context: String(trace.status ?? '') });
    }
  }
  // Newest first, which is the order the console renders and the opposite of
  // what the vendor returns.
  traces.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { state: stateOf(String(result.deliverystatus ?? '')), traces };
}

/**
 * `2026-09-24 10:00:00` is Shanghai wall time. Read with `new Date` it would be
 * whatever zone the container happens to run in.
 */
function vendorTime(text: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(text.trim());
  if (match === null) return null;
  const at = new Date(`${match[1]}T${match[2]}+08:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 0 揽件, 1 在途, 2 派件中, 3 已签收, 4 派送失败, 5 疑难件, 6 退件签收. */
function stateOf(code: string): TrackingResult['state'] {
  switch (code) {
    case '0':
    case '1':
      return 'in_transit';
    case '2':
      return 'delivering';
    case '3':
      return 'delivered';
    case '4':
    case '5':
    case '6':
      return 'exception';
    default:
      return 'unknown';
  }
}

async function readCache(ctx: Ctx, key: string): Promise<TrackingResult | null> {
  const raw = await ctx.redis.get(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; traces?: unknown };
    const traces = Array.isArray(parsed.traces) ? parsed.traces : [];
    return {
      state: (parsed.state ?? 'unknown') as TrackingResult['state'],
      traces: traces.map((trace) => {
        const entry = trace as { at?: unknown; context?: unknown };
        return { at: new Date(String(entry.at ?? '')), context: String(entry.context ?? '') };
      }),
    };
  } catch {
    return null;
  }
}

function empty(): TrackingResult {
  return { state: 'unknown', traces: [] };
}

// ---------------------------------------------------------------------------
// 「测试」
// ---------------------------------------------------------------------------

export type TrackingProbe =
  | { reached: false; reason: string }
  | { reached: true; status: string; message: string; result: TrackingResult };

/**
 * One uncached lookup, for 物流设置 → 「测试查询」.
 *
 * `track` hides every failure as an empty result, because an order page has no
 * use for the reason. The test is only asking for the reason, so this returns
 * it. `reached` means the credential was accepted, even when the carrier has
 * never heard of the number. An empty or unknown `companyCode` lets the vendor
 * guess the carrier from the number. A phone the operator typed is sent
 * whatever the carrier: they typed it because the vendor asked for it.
 */
export async function probeAliyunTracking(
  ctx: Ctx,
  appCode: string,
  input: { companyCode: string; trackingNo: string; phone: string },
): Promise<TrackingProbe> {
  const query = aliyunQuery({
    trackingNo: input.trackingNo,
    type: aliyunExpressType(input.companyCode),
    phone: input.phone,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ALIYUN_HOST}?${query.toString()}`, {
      method: 'GET',
      headers: { Authorization: `APPCODE ${appCode}` },
      signal: controller.signal,
    });
    if (response.status === 401) return { reached: false, reason: 'AppCode 无效' };
    if (response.status === 403) {
      return { reached: false, reason: '没有可用的调用次数：云市场套餐未购买或已用完' };
    }
    if (!response.ok) return { reached: false, reason: `接口返回 HTTP ${response.status}` };
    const payload = (await response.json()) as { status?: unknown; msg?: unknown };
    return {
      reached: true,
      status: String(payload.status ?? ''),
      message: String(payload.msg ?? ''),
      result: parseAliyun(payload),
    };
  } catch (error) {
    ctx.logger.warn({ err: error }, '物流测试查询失败');
    return {
      reached: false,
      reason: controller.signal.aborted
        ? `${TIMEOUT_MS / 1000} 秒内没有响应`
        : '连不上物流查询接口，请检查服务器网络',
    };
  } finally {
    clearTimeout(timer);
  }
}
