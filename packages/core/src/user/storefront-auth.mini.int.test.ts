import { users } from '@shop/db/schema/user';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import { wechatMiniConfig } from '../system';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import './index';
import * as auth from './storefront-auth.service';
import { storefrontAuthConfig } from './storefront-auth.config';

/**
 * 微信授权手机号 against a fake `api.weixin.qq.com`.
 *
 * The rest of the sign-in suite (`storefront-auth.int.test.ts`) runs on the
 * in-memory `WechatIdentityPort` fake, which answers whatever a test seeded.
 * This file deliberately does not: it keeps the *real* adapter and the `wechat`
 * domain's HTTP client and points them at `startFakeOaServer()`, so the
 * access-token fetch, the mini-program credential check and WeChat's own
 * refusal codes are all in the path. A phone binding that works against a
 * hand-written stub and fails against a server that can say `40029` is the bug
 * this file exists to catch.
 *
 * Nothing here reaches the real WeChat: the fake is a `node:http` server on a
 * loopback port, and `apiBaseUrl` is pointed at it.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const PHONE = '13800138000';
const PHONE_CODE = 'mp-phone-code-abc';
const OPENID = 'oMINI_______________aaaa';

const anonymous: Actor = { kind: 'anonymous', id: null, permissions: [], isSuper: false };

function asAnonymous(): Ctx {
  return { ...harness.as(anonymous), platform: 'wechat-mini' };
}

function asUser(id: number): Ctx {
  return {
    ...harness.as({ kind: 'user', id, permissions: [], isSuper: false }),
    platform: 'wechat-mini',
  };
}

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  oa = await startFakeOaServer();
}, 180_000);

afterAll(async () => {
  await oa?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  oa.reset();
  resetWechatTokenFlight();

  await harness.ctx.config.set(wechatConfig, {
    miniAppId: oa.miniAppId,
    miniAppSecret: oa.miniAppSecret,
    apiBaseUrl: oa.url,
  });
  await harness.ctx.config.set(wechatMiniConfig, { enabled: true });
  // The shop under test lets a shopper in without a number and offers the
  // binding button afterwards — which is the account state this route is for.
  await harness.ctx.config.set(storefrontAuthConfig, { requirePhoneForWechat: false });
});

/** Sign in through the mini program and come back with an account that has no phone. */
async function signedInWithoutPhone(openid = OPENID): Promise<number> {
  const code = `login-${openid}`;
  oa.setMiniCode(code, { openid });
  const result = await auth.miniLogin(asAnonymous(), { code });
  const id = result.session?.user.id;
  if (!id) throw new Error(`fixture: mini login did not produce a session (${result.status})`);
  return Number(id);
}

async function phoneOf(id: number): Promise<string | null> {
  const [row] = await harness.ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
  return row?.phone ?? null;
}

describe('bindPhoneFromMini', () => {
  it('binds the number WeChat answered with, which the request never carried', async () => {
    const id = await signedInWithoutPhone();
    oa.setPhoneCode(PHONE_CODE, { phone: PHONE, countryCode: '86' });

    await expect(auth.bindPhoneFromMini(asUser(id), { phoneCode: PHONE_CODE })).resolves.toEqual({
      ok: true,
    });
    expect(await phoneOf(id)).toBe(PHONE);

    // The number came back over the server-to-server call, and the call was
    // made with the mini-program's own access token — presenting the OA's is
    // how this breaks on a shop that filled in only one pair.
    const [call] = oa.callsTo('/wxa/business/getuserphonenumber');
    expect(call?.body).toEqual({ code: PHONE_CODE });
    expect(call?.accessToken).toBeTruthy();
  });

  it('refuses a spent or forged code and leaves the account without a number', async () => {
    const id = await signedInWithoutPhone();
    // Nothing seeded: the fake answers `40029 invalid code`, which is what a
    // code that was already redeemed really looks like.
    await expect(
      auth.bindPhoneFromMini(asUser(id), { phoneCode: 'never-issued' }),
    ).rejects.toMatchObject({ code: 'AUTH_WECHAT_CODE_INVALID' });
    expect(await phoneOf(id)).toBeNull();
  });

  it('refuses a number another account already holds', async () => {
    const first = await signedInWithoutPhone('oMINI_______________bbbb');
    oa.setPhoneCode('first-code', { phone: PHONE });
    await auth.bindPhoneFromMini(asUser(first), { phoneCode: 'first-code' });

    const second = await signedInWithoutPhone('oMINI_______________cccc');
    oa.setPhoneCode('second-code', { phone: PHONE });
    await expect(
      auth.bindPhoneFromMini(asUser(second), { phoneCode: 'second-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_PHONE_TAKEN' });
    expect(await phoneOf(second)).toBeNull();
  });

  it('refuses a second binding without spending the code', async () => {
    const id = await signedInWithoutPhone();
    oa.setPhoneCode(PHONE_CODE, { phone: PHONE });
    await auth.bindPhoneFromMini(asUser(id), { phoneCode: PHONE_CODE });

    const before = oa.callsTo('/wxa/business/getuserphonenumber').length;
    await expect(
      auth.bindPhoneFromMini(asUser(id), { phoneCode: 'another-code' }),
    ).rejects.toMatchObject({ code: 'AUTH_PHONE_ALREADY_BOUND' });
    // A double tap must not burn a fresh WeChat code to find out there was
    // nothing to do — the account is checked first.
    expect(oa.callsTo('/wxa/business/getuserphonenumber')).toHaveLength(before);
  });

  it('refuses while the mini program is switched off', async () => {
    const id = await signedInWithoutPhone();
    oa.setPhoneCode(PHONE_CODE, { phone: PHONE });
    await harness.ctx.config.set(wechatMiniConfig, { enabled: false });

    await expect(
      auth.bindPhoneFromMini(asUser(id), { phoneCode: PHONE_CODE }),
    ).rejects.toMatchObject({ code: 'AUTH_WECHAT_NOT_CONFIGURED' });
    expect(await phoneOf(id)).toBeNull();
  });
});
