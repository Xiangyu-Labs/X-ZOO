import type {
  JssdkConfig,
  JssdkConfigQuery,
  SubscribeTemplates,
  SubscribeTemplatesQuery,
} from '@shop/contracts/wechat-oa/schemas';
import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { isTrustedHost } from '../system';
import { wechatOaRuntimeConfig } from './wechat-oa.config';
import { jsapiTicket } from './wechat-oa.client';
import { requireOaCredentials } from './wechat-oa.credentials';

/**
 * The two things the H5 and mini-program clients ask the server for.
 *
 * Neither needs a login: a shop's JS-SDK signature and its subscribe-template
 * ids are public configuration, and requiring a session would break the share
 * card on a page a customer opened from a friend.
 */

// ---------------------------------------------------------------------------
// JS-SDK
// ---------------------------------------------------------------------------

/**
 * Signs one page URL for `wx.config`.
 *
 * ## Only our own pages are signed
 *
 * `jsapi_ticket` is the account's, and a signature over an arbitrary URL is a
 * signature for somebody else's page: hand it out freely and any site can call
 * `wx.chooseWXPay` and `wx.getLocation` in our name, with our brand on the
 * permission sheet. So the URL's host must be the site's own or one an operator
 * listed in `wechat-oa-runtime.jsApiAllowedHosts`.
 *
 * ## The signature itself
 *
 * `sha1` over the four fields sorted by key, joined as `k=v&k=v`, with the URL
 * exactly as the browser reports it (`location.href.split('#')[0]`). Any
 * difference — a trailing slash, an added parameter, the fragment — produces
 * `invalid signature` in the browser and nothing at all on the server, which is
 * why the URL is taken from the client rather than reconstructed here.
 */
export async function jssdkConfigFor(ctx: Ctx, query: JssdkConfigQuery): Promise<JssdkConfig> {
  const credentials = await requireOaCredentials(ctx);

  const url = query.url.split('#')[0] ?? '';
  await assertAllowed(ctx, url);

  const ticket = await jsapiTicket(ctx, credentials.appId);
  const nonceStr = randomBytes(8).toString('hex');
  const timestamp = String(Math.floor(ctx.clock.now().getTime() / 1000));

  return {
    appId: credentials.appId,
    timestamp,
    nonceStr,
    signature: jsapiSignature({ ticket, nonceStr, timestamp, url }),
  };
}

/** `sha1(jsapi_ticket=…&noncestr=…&timestamp=…&url=…)` — the keys are lower-case and sorted. */
export function jsapiSignature(args: {
  ticket: string;
  nonceStr: string;
  timestamp: string;
  url: string;
}): string {
  const message = [
    `jsapi_ticket=${args.ticket}`,
    `noncestr=${args.nonceStr}`,
    `timestamp=${args.timestamp}`,
    `url=${args.url}`,
  ].join('&');
  return createHash('sha1').update(message, 'utf8').digest('hex');
}

/**
 * Refuses a URL that is not ours before it is ever signed.
 *
 * Which hosts are ours is the deployment's business, not this domain's, so the
 * question goes to `isTrustedHost` in `@shop/core/system`, plus the account's
 * own 授权域名 list in `wechat-oa-runtime`. Everything this function still
 * decides is WeChat-specific: the scheme must be http(s), the fragment is
 * already gone, and a URL that does not parse is a refusal rather than a crash.
 */
export async function assertAllowed(ctx: Ctx, url: string): Promise<void> {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new DomainError('WECHAT_OA_URL_NOT_ALLOWED');
    }
    host = parsed.host.toLowerCase();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('WECHAT_OA_URL_NOT_ALLOWED', { message: '待签名的地址不是合法的 URL' });
  }

  // The deployment's own hosts come from `site`; the 公众号 JS 安全域名 list is
  // a statement about the WeChat account and stays in this domain's runtime
  // group. Either is enough.
  if (!(await isTrustedHost(ctx, host)) && !(await isListedJsApiHost(ctx, host))) {
    throw new DomainError('WECHAT_OA_URL_NOT_ALLOWED', { details: { host } });
  }
}

/** A host an operator listed under JS-SDK 授权域名, in either spelling. */
async function isListedJsApiHost(ctx: Ctx, host: string): Promise<boolean> {
  const runtime = await ctx.config.get(wechatOaRuntimeConfig);
  return runtime.jsApiAllowedHosts.split(',').some((entry) => hostOf(entry) === host);
}

/**
 * The host of `https://m.example.com/x`, of `m.example.com:8443` and of
 * `m.example.com` alike — operators paste both spellings — and `''` for
 * anything that is neither, so a bad entry never becomes "allow everything".
 */
function hostOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// subscribe templates
// ---------------------------------------------------------------------------

/**
 * Which template ids the client should ask permission for at this moment.
 *
 * `wx.requestSubscribeMessage` must be called from a user gesture and takes the
 * ids up front, so the client cannot discover them from the notification
 * templates the way the sender does. The scenes are ours; an unconfigured scene
 * answers with an empty list and the client skips the prompt rather than
 * showing an empty permission sheet.
 */
export async function subscribeTemplatesFor(
  ctx: Ctx,
  query: SubscribeTemplatesQuery,
): Promise<SubscribeTemplates> {
  const runtime = await ctx.config.get(wechatOaRuntimeConfig);
  const raw =
    query.scene === 'order-create'
      ? runtime.subscribeOrderCreate
      : query.scene === 'order-pay'
        ? runtime.subscribeOrderPay
        : query.scene === 'order-unpaid'
          ? runtime.subscribeOrderUnpaid
          : query.scene === 'order-ship'
            ? runtime.subscribeOrderShip
            : runtime.subscribeRefund;

  return { templateIds: templateIdsOf(raw) };
}

/**
 * Every scene at once, for `GET /api/v1/app/config` (registered from
 * `registerWechatOaDomain()`). Same parsing as `subscribeTemplatesFor`, so the
 * launch payload and the per-scene route always agree.
 */
export async function allSubscribeTemplates(ctx: Ctx): Promise<{
  orderCreate: string[];
  orderPay: string[];
  orderUnpaid: string[];
  orderShip: string[];
  refund: string[];
}> {
  const runtime = await ctx.config.get(wechatOaRuntimeConfig);
  return {
    orderCreate: templateIdsOf(runtime.subscribeOrderCreate),
    orderPay: templateIdsOf(runtime.subscribeOrderPay),
    orderUnpaid: templateIdsOf(runtime.subscribeOrderUnpaid),
    orderShip: templateIdsOf(runtime.subscribeOrderShip),
    refund: templateIdsOf(runtime.subscribeRefund),
  };
}

/** Comma-separated as the operator typed it → trimmed, non-empty, first occurrence kept. */
function templateIdsOf(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    ),
  ];
}
