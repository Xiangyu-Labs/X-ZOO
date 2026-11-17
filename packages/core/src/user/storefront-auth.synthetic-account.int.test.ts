import { users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import { wechatMiniConfig } from '../system';
import { wechatConfig } from '../wechat';
import './index';
import * as auth from './storefront-auth.service';
import type * as UserRules from './user.rules';
import { storefrontAuthConfig } from './storefront-auth.config';
import {
  fakeWechatIdentityPort,
  registerWechatIdentityPort,
  resetWechatIdentityPort,
} from './wechat-identity.port';

/**
 * #110 — the `wx_…` account a phone-free WeChat sign-in is given is random, and
 * random can repeat. A repeat must draw a new one: before, the insert's
 * conflict was read as "this account already exists, it is yours", and the new
 * shopper's WeChat was bound to a stranger's account.
 *
 * The generator is pinned here so the collision is certain rather than a
 * one-in-2^64 event.
 */
const drawn = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('./user.rules', async (importOriginal) => {
  const actual = await importOriginal<typeof UserRules>();
  return {
    ...actual,
    syntheticAccount: (prefix = 'wx') => drawn.queue.shift() ?? actual.syntheticAccount(prefix),
  };
});

let harness: TestCtx;
const anonymous: Actor = { kind: 'anonymous', id: null, permissions: [], isSuper: false };
const asAnonymous = (): Ctx => harness.as(anonymous);

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  await harness.ctx.config.set(storefrontAuthConfig, { requirePhoneForWechat: false });
  await harness.ctx.config.set(wechatMiniConfig, { enabled: true });
  await harness.ctx.config.set(wechatConfig, { miniAppId: 'wx-mini' });
});

afterEach(() => {
  resetWechatIdentityPort();
  drawn.queue = [];
});

describe('a phone-free WeChat account (#110)', () => {
  it('draws a new account name when the random one is taken, never signing in to its owner', async () => {
    const wechat = fakeWechatIdentityPort();
    registerWechatIdentityPort(wechat);
    wechat.setMiniSession('code-a', { openid: 'o_first' });
    wechat.setMiniSession('code-b', { openid: 'o_second' });

    drawn.queue = ['wx_aaaaaaaaaaaaaaaa'];
    const first = await auth.miniLogin(asAnonymous(), { code: 'code-a' });

    drawn.queue = ['wx_aaaaaaaaaaaaaaaa', 'wx_bbbbbbbbbbbbbbbb'];
    const second = await auth.miniLogin(asAnonymous(), { code: 'code-b' });

    expect(second).toMatchObject({ status: 'signed-in', registered: true });
    expect(second.session!.user.id).not.toBe(first.session!.user.id);
    const [row] = await harness.ctx.db
      .select({ account: users.account })
      .from(users)
      .where(eq(users.id, Number(second.session!.user.id)));
    expect(row?.account).toBe('wx_bbbbbbbbbbbbbbbb');
  });
});
