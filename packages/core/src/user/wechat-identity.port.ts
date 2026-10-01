import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';

/**
 * The narrow seam between storefront sign-in and WeChat's HTTP API.
 *
 * The `wechat` domain owns the first-party client (`core/src/wechat/`,
 * `WechatCoreClient`); this domain codes against three methods it can describe
 * exactly, with a fake for the tests. The adapter over that client is
 * `wechat-identity.adapter.ts`, registered by `registerUserDomain()`. Each
 * method takes the request's `Ctx` because the client is built per request
 * (credentials come from the config registry and a change must take effect on
 * the next call, not the next deploy):
 *
 * | Port method        | `WechatCoreClient`                                                          |
 * | ------------------ | --------------------------------------------------------------------------- |
 * | `miniCodeToSession`| `miniCode2Session(code)` → `{ openid, unionid?, sessionKey }`                |
 * | `oaCodeToUser`     | `oaCodeExchange(code)` then, for `snsapi_userinfo`, `oaUserInfo({...})`      |
 * | `miniPhoneNumber`  | **no method today** — `call('mini', { method: 'POST', path: '/wxa/business/getuserphonenumber', body: { code } })` |
 *
 * Three methods rather than "give me the client": this domain has no business
 * being able to send a template message or invalidate an access token, and a
 * port it cannot misuse is a port that does not have to be reviewed again.
 *
 * Every method **throws a `DomainError`** rather than returning a WeChat
 * envelope. Mapping `errcode` to a refusal the shopper can act on is the
 * adapter's job; the sign-in service should never see a number.
 */

export interface WechatMiniSession {
  openid: string;
  unionid?: string | undefined;
  /** Never leaves the server and is never persisted. Present for parity with the client's type. */
  sessionKey?: string | undefined;
}

export interface WechatOaUser {
  openid: string;
  unionid?: string | undefined;
  nickname?: string | undefined;
  avatarUrl?: string | undefined;
}

export interface WechatPhoneNumber {
  /** Mainland numbers come back without the country code; that is what we store. */
  phone: string;
  countryCode?: string | undefined;
}

export interface WechatIdentityPort {
  /** `wx.login()`'s code → openid. Throws `AUTH_WECHAT_CODE_INVALID` on a spent code. */
  miniCodeToSession(ctx: Ctx, code: string): Promise<WechatMiniSession>;
  /** `getPhoneNumber`'s code → the verified number. */
  miniPhoneNumber(ctx: Ctx, code: string): Promise<WechatPhoneNumber>;
  /** The OAuth `code` on the redirect back → openid and, with consent, a profile. */
  oaCodeToUser(ctx: Ctx, code: string): Promise<WechatOaUser>;
}

let port: WechatIdentityPort | undefined;

export function registerWechatIdentityPort(impl: WechatIdentityPort): void {
  port = impl;
}

/**
 * `undefined` until something registers an adapter, which the service turns
 * into `AUTH_WECHAT_NOT_CONFIGURED`. Failing closed matters here: the
 * alternative is a WeChat login route that silently signs people in without
 * ever having talked to WeChat.
 */
export function getWechatIdentityPort(): WechatIdentityPort | undefined {
  return port;
}

/** Test helper. Never call this from app code. */
export function resetWechatIdentityPort(): void {
  port = undefined;
}

// ---------------------------------------------------------------------------
// fake
// ---------------------------------------------------------------------------

export interface FakeWechatIdentityPort extends WechatIdentityPort {
  /** `code` → what `miniCodeToSession` should answer. */
  setMiniSession(code: string, session: WechatMiniSession): void;
  setOaUser(code: string, user: WechatOaUser): void;
  setPhone(code: string, phone: WechatPhoneNumber): void;
  reset(): void;
}

/**
 * An in-memory adapter for tests.
 *
 * It lives here rather than in `@shop/testing` because only this domain's tests
 * use it. An unknown code throws the same `AUTH_WECHAT_CODE_INVALID` the real
 * adapter will, so the refusal path is exercised by default rather than by a
 * special mode.
 */
export function fakeWechatIdentityPort(
  options: { throwOn?: (code: string) => Error | undefined } = {},
): FakeWechatIdentityPort {
  const sessions = new Map<string, WechatMiniSession>();
  const users = new Map<string, WechatOaUser>();
  const phones = new Map<string, WechatPhoneNumber>();

  function lookup<T>(map: Map<string, T>, code: string): Promise<T> {
    const thrown = options.throwOn?.(code);
    if (thrown) return Promise.reject(thrown);
    const found = map.get(code);
    if (!found) return Promise.reject(new DomainError('AUTH_WECHAT_CODE_INVALID'));
    return Promise.resolve(found);
  }

  return {
    miniCodeToSession: (_ctx, code) => lookup(sessions, code),
    miniPhoneNumber: (_ctx, code) => lookup(phones, code),
    oaCodeToUser: (_ctx, code) => lookup(users, code),
    setMiniSession: (code, session) => void sessions.set(code, session),
    setOaUser: (code, user) => void users.set(code, user),
    setPhone: (code, phone) => void phones.set(code, phone),
    reset() {
      sessions.clear();
      users.clear();
      phones.clear();
    },
  };
}
