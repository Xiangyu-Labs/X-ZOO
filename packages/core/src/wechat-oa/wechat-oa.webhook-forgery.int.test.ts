import { wechatIdentities, wechatQrcodeScans } from '@shop/db/schema/wechat';
import { users } from '@shop/db/schema/user';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../kernel/context';
import { wechatOaConfig } from '../system';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import { encryptMessage, signatureOf } from './wechat-oa.crypto';
import * as qrcode from './wechat-oa.qrcode.service';
import { handleEvent, verifyUrl } from './wechat-oa.webhook.service';

/**
 * The Official Account callback, read as an attacker.
 *
 * In 明文 mode WeChat's `signature` is `sha1(sort(token, timestamp, nonce))`:
 * it does **not** cover the body. So the one thing that stops a valid triple
 * from being replayed against a body of the attacker's choosing is what the
 * endpoint does with the triple: a freshness window, single use, and the
 * operator's 消息加解密方式 — not the request's `encrypt_type` — choosing the
 * path.
 *
 * WeChat puts `signature`, `timestamp` and `nonce` on the query string of every
 * callback, in 安全模式 too (next to `msg_signature`), so every access-log line
 * of the webhook holds a triple that is valid forever.
 *
 * The three refusals below are those three rules: a 300 s window,
 * `(timestamp, nonce)` spent on one body, and the configured mode choosing the
 * path.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const TOKEN = 'shoptoken';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const GH = 'gh_1234567890ab';
const VICTIM = 'oVICTIMOPENID0000000000000';

const admin: Actor = { kind: 'admin', id: 1, permissions: [], isSuper: true };

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, actor: admin });
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
});

async function configure(
  messageMode: 'plain' | 'compatible' | 'safe',
  enabled = true,
): Promise<void> {
  await harness.ctx.config.set(wechatConfig, {
    oaAppId: oa.appId,
    oaAppSecret: oa.appSecret,
    apiBaseUrl: oa.url,
  });
  await harness.ctx.config.set(wechatOaConfig, {
    enabled,
    token: TOKEN,
    encodingAesKey: AES_KEY,
    messageMode,
  });
}

/** A triple exactly as WeChat signs it — i.e. one that could be read off a log line. */
function triple(timestamp: number, nonce = '1372623149') {
  const ts = String(timestamp);
  return { timestamp: ts, nonce, signature: signatureOf([TOKEN, ts, nonce]) };
}

function event(openid: string, name: string, eventKey = '', createTime = NOW_SECONDS): string {
  return (
    `<xml><ToUserName><![CDATA[${GH}]]></ToUserName>` +
    `<FromUserName><![CDATA[${openid}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
    `<Event><![CDATA[${name}]]></Event><EventKey><![CDATA[${eventKey}]]></EventKey></xml>`
  );
}

async function followedVictim(): Promise<void> {
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: 'oa-victim' })
    .returning({ id: users.id });
  await harness.ctx.db
    .insert(wechatIdentities)
    .values({ userId: user!.id, platform: 'oa', openid: VICTIM, subscribed: true });
}

async function victimSubscribed(): Promise<boolean | undefined> {
  const [row] = await harness.ctx.db
    .select()
    .from(wechatIdentities)
    .where(eq(wechatIdentities.openid, VICTIM));
  return row?.subscribed;
}

describe('what a valid signature triple is good for', () => {
  it('holds in 安全模式 for a genuine encrypted delivery (the baseline)', async () => {
    await configure('safe');
    await followedVictim();
    const signed = triple(NOW_SECONDS);
    const encrypt = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: oa.appId,
      message: event(VICTIM, 'unsubscribe'),
    });

    const result = await handleEvent(harness.ctx, {
      query: {
        ...signed,
        encrypt_type: 'aes',
        msg_signature: signatureOf([TOKEN, signed.timestamp, signed.nonce, encrypt]),
      },
      body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
    });

    expect(result.status).toBe(200);
    expect(await victimSubscribed()).toBe(false);
  });

  // The downgrade: take the query string of any 安全模式 delivery, drop
  // `encrypt_type` and `msg_signature`, and post a plaintext body. The
  // operator chose 安全模式 precisely so that the body is authenticated.
  it('refuses a plaintext callback when the account is configured in 安全模式', async () => {
    await configure('safe');
    await followedVictim();

    const result = await handleEvent(harness.ctx, {
      query: triple(NOW_SECONDS),
      body: event(VICTIM, 'unsubscribe'),
    });

    expect(result.status).toBe(403);
    expect(await victimSubscribed()).toBe(true);
  });

  // A triple from last month's access log.
  it('refuses a triple whose timestamp is outside a five-minute window', async () => {
    await configure('plain');
    await followedVictim();

    const result = await handleEvent(harness.ctx, {
      query: triple(NOW_SECONDS - 30 * 24 * 60 * 60),
      body: event(VICTIM, 'unsubscribe'),
    });

    expect(result.status).toBe(403);
    expect(await victimSubscribed()).toBe(true);
  });

  // Inside the window, the body-derived dedupe key does not help: a second,
  // different body under the same triple is a new key. Only spending the
  // triple (or the nonce) closes it.
  it('refuses a second, different body under a triple that was already used', async () => {
    await configure('plain');
    const code = await qrcode.create(harness.ctx.as(admin), {
      name: '海报',
      scene: 'CH_POSTER',
      expireSeconds: 0,
    });
    const signed = triple(NOW_SECONDS);

    const first = await handleEvent(harness.ctx, {
      query: signed,
      body: event('oGENUINEFOLLOWER000000000', 'subscribe', 'qrscene_CH_POSTER'),
    });
    expect(first.status).toBe(200);

    // Ten "new followers" off one genuine signature.
    for (let i = 0; i < 10; i += 1) {
      await handleEvent(harness.ctx, {
        query: signed,
        body: event(`oFORGED${String(i).padStart(19, '0')}`, 'subscribe', 'qrscene_CH_POSTER'),
      });
    }

    expect(await harness.ctx.db.select().from(wechatQrcodeScans)).toHaveLength(1);
    expect((await qrcode.detail(harness.ctx.as(admin), { id: code.id })).followCount).toBe(1);
  });

  it('still answers WeChat’s own re-delivery of the same body under the same triple', async () => {
    await configure('plain');
    await followedVictim();
    const delivery = { query: triple(NOW_SECONDS), body: event(VICTIM, 'unsubscribe') };

    const first = await handleEvent(harness.ctx, delivery);
    const retry = await handleEvent(harness.ctx, delivery);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await victimSubscribed()).toBe(false);
  });

  it('accepts a triple a little either side of the clock, inside the window', async () => {
    await configure('plain');
    await followedVictim();
    const result = await handleEvent(harness.ctx, {
      query: triple(NOW_SECONDS + 299, '99'),
      body: event(VICTIM, 'unsubscribe'),
    });
    expect(result.status).toBe(200);
    expect(await victimSubscribed()).toBe(false);
  });

  it('refuses every callback while the account is switched off', async () => {
    await configure('plain', false);
    await followedVictim();
    const result = await handleEvent(harness.ctx, {
      query: triple(NOW_SECONDS),
      body: event(VICTIM, 'unsubscribe'),
    });
    expect(result.status).toBe(403);
    expect(await victimSubscribed()).toBe(true);
  });

  it('holds a 兼容模式 delivery that carries an envelope to msg_signature', async () => {
    await configure('compatible');
    await followedVictim();
    const encrypt = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: oa.appId,
      message: event(VICTIM, 'unsubscribe'),
    });
    // A plaintext body next to the envelope, and no msg_signature: the plain
    // signature would pass, but the envelope is preferred when present.
    const result = await handleEvent(harness.ctx, {
      query: triple(NOW_SECONDS),
      body: `${event(VICTIM, 'unsubscribe').slice(0, -6)}<Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
    });
    expect(result.status).toBe(403);
    expect(await victimSubscribed()).toBe(true);
  });

  it('refuses to echo the URL handshake under a stale triple', async () => {
    await configure('plain');
    const stale = { ...triple(NOW_SECONDS - 3600), echostr: 'reflect-me' };
    await expect(verifyUrl(harness.ctx, stale)).resolves.toEqual({
      status: 403,
      body: 'invalid signature',
    });
    const fresh = { ...triple(NOW_SECONDS), echostr: 'reflect-me' };
    await expect(verifyUrl(harness.ctx, fresh)).resolves.toEqual({
      status: 200,
      body: 'reflect-me',
    });
  });
});
