import { describe, expect, it, vi } from 'vitest';
import { buildMiniPush } from '@shop/testing/wechat';
import type { Ctx } from '../kernel/context';
import { handleMiniPush } from './wechat.mini-push';

/**
 * The mini program's push URL with the nonce store (Redis) down, without a
 * database: what the webhook answers before it would record anything.
 *
 * `trade_manage_order_settlement` is the event worth forging — it marks an
 * order received — and in 明文/兼容模式 the only thing binding a signed URL to
 * its body is the single-use triple in Redis (WXSHIP-008).
 */

const NOW_SECONDS = 1_780_000_000;
const TOKEN = 'mini-push-token-0001';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const APP_ID = 'wxfakemini000001';

type Mode = 'plain' | 'compatible' | 'safe';

function fakeCtx(options: { mode: Mode; redisDown: boolean }) {
  const store = new Map<string, string>();
  const down = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
  const withTx = vi.fn(() => Promise.reject(new Error('no database in a unit test')));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    clock: { now: () => new Date(NOW_SECONDS * 1000) },
    config: {
      get: () =>
        Promise.resolve({
          miniToken: TOKEN,
          miniAesKey: AES_KEY,
          miniAppId: APP_ID,
          miniMessageMode: options.mode,
        }),
    },
    redis: {
      set: (key: string, value: string) => {
        if (options.redisDown) return down();
        if (store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve('OK');
      },
      get: (key: string) => (options.redisDown ? down() : Promise.resolve(store.get(key) ?? null)),
    },
    logger,
    withTx,
  } as unknown as Ctx;
  return { ctx, withTx, logger };
}

/** A push nobody handles is answered `success` without a write — enough to see it was let in. */
const UNHANDLED = { Event: 'some_event_nobody_handles', MsgType: 'event' };
const SETTLEMENT = {
  Event: 'trade_manage_order_settlement',
  MsgType: 'event',
  transaction_id: '4200000000000000000000000001',
  merchant_trade_no: 'P2026060100000001',
};

function push(envelope: 'plain' | 'safe', message: Record<string, unknown>) {
  return buildMiniPush({
    token: TOKEN,
    aesKey: AES_KEY,
    appId: APP_ID,
    message,
    mode: envelope,
    timestamp: NOW_SECONDS,
    nonce: 'n0nce01',
  });
}

describe('WXSHIP-008 — without the nonce store, only 安全模式 takes a push', () => {
  it('refuses a plaintext push in 明文模式 with a retryable 503, and records nothing', async () => {
    const { ctx, withTx, logger } = fakeCtx({ mode: 'plain', redisDown: true });
    const answer = await handleMiniPush(ctx, push('plain', SETTLEMENT));
    expect(answer.status).toBe(503);
    expect(answer.body).not.toBe('success');
    expect(withTx).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { mode: 'plain' },
      expect.stringContaining('no nonce store'),
    );
  });

  it('refuses in 兼容模式 too, a plaintext and an encrypted delivery alike', async () => {
    for (const envelope of ['plain', 'safe'] as const) {
      const { ctx, withTx } = fakeCtx({ mode: 'compatible', redisDown: true });
      const answer = await handleMiniPush(ctx, push(envelope, SETTLEMENT));
      expect(answer.status).toBe(503);
      expect(withTx).not.toHaveBeenCalled();
    }
  });

  it('still takes an encrypted push in 安全模式, where the signature covers the body', async () => {
    const { ctx } = fakeCtx({ mode: 'safe', redisDown: true });
    expect(await handleMiniPush(ctx, push('safe', UNHANDLED))).toEqual({
      status: 200,
      body: 'success',
    });
  });

  it('takes a plaintext push in 明文模式 while the store is up, and refuses the triple for another body', async () => {
    const { ctx } = fakeCtx({ mode: 'plain', redisDown: false });
    expect(await handleMiniPush(ctx, push('plain', UNHANDLED))).toEqual({
      status: 200,
      body: 'success',
    });
    // Same signed triple, another body: the store remembers the first one.
    const forged = { ...push('plain', UNHANDLED), body: JSON.stringify(SETTLEMENT) };
    expect((await handleMiniPush(ctx, forged)).status).toBe(403);
  });
});
