import { attachments } from '@shop/db/schema/storage';
import { users } from '@shop/db/schema/user';
import {
  wechatAutoReplies,
  wechatIdentities,
  wechatOaMenus,
  wechatQrcodeScans,
} from '@shop/db/schema/wechat';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { wechatOaConfig } from '../system';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import { encryptMessage, signatureOf } from './wechat-oa.crypto';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import * as media from './wechat-oa.media.service';
import * as menu from './wechat-oa.menu.service';
import * as qrcode from './wechat-oa.qrcode.service';
import * as reply from './wechat-oa.reply.service';
import * as storefront from './wechat-oa.storefront.service';
import { wechatOaRuntimeConfig } from './wechat-oa.config';
import { handleEvent, verifyUrl } from './wechat-oa.webhook.service';

/**
 * The Official Account domain against a real database, real Redis and a fake
 * `api.weixin.qq.com`.
 *
 * Two of the invariants this domain exists to prove live here — "a webhook
 * replay with the same MsgId replies once" and "a webhook with a bad signature
 * is rejected before any parsing side effect" — and both are written as the
 * *observable* thing: what came back, and what the database says afterwards.
 * The races are next door in `wechat-oa.concurrency.int.test.ts`.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const TOKEN = 'shoptoken';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const OPENID = 'oABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GH = 'gh_1234567890ab';

const admin: Actor = { kind: 'admin', id: 1, permissions: [], isSuper: true };

function ctx(): Ctx {
  return harness.ctx.as(admin);
}

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, actor: admin });
  oa = await startFakeOaServer();
  // The deployment's own address, which is where `publicOrigin` reads it from
  // — not from a config group. See `wechat-oa.trusted-hosts.ts`.
  process.env['PUBLIC_ORIGIN'] = 'https://shop.example.test';
}, 180_000);

afterAll(async () => {
  delete process.env['PUBLIC_ORIGIN'];
  await oa?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  oa.reset();
  resetWechatTokenFlight();
  await configure();
});

async function configure(overrides: { messageMode?: 'plain' | 'safe' } = {}): Promise<void> {
  await harness.ctx.config.set(wechatConfig, {
    oaAppId: oa.appId,
    oaAppSecret: oa.appSecret,
    apiBaseUrl: oa.url,
  });
  await harness.ctx.config.set(wechatOaConfig, {
    enabled: true,
    token: TOKEN,
    encodingAesKey: AES_KEY,
    messageMode: overrides.messageMode ?? 'plain',
  });
  await harness.ctx.config.set(wechatOaRuntimeConfig, {
    jsApiAllowedHosts: '',
    scanDedupeSeconds: 300,
    subscribeOrderPay: 'TPL_PAY_1, TPL_PAY_2,TPL_PAY_1',
  });
}

// ---------------------------------------------------------------------------
// callback fixtures
// ---------------------------------------------------------------------------

/**
 * A triple signed at `NOW`, with a nonce of its own: the callback spends each
 * `(timestamp, nonce)` on one body and refuses a timestamp more than five
 * minutes off its clock, exactly as WeChat's own deliveries expect.
 */
let nonceSeq = 1372623149;
function plainQuery(timestamp = String(NOW_SECONDS), nonce = String((nonceSeq += 1))) {
  return {
    timestamp,
    nonce,
    signature: signatureOf([TOKEN, timestamp, nonce]),
  } satisfies Record<string, string>;
}

function textMessage(content: string, msgId = '24000000000000001'): string {
  return (
    `<xml><ToUserName><![CDATA[${GH}]]></ToUserName>` +
    `<FromUserName><![CDATA[${OPENID}]]></FromUserName>` +
    `<CreateTime>1767668400</CreateTime><MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${content}]]></Content><MsgId>${msgId}</MsgId></xml>`
  );
}

function eventMessage(event: string, eventKey = '', createTime = '1767668400'): string {
  return (
    `<xml><ToUserName><![CDATA[${GH}]]></ToUserName>` +
    `<FromUserName><![CDATA[${OPENID}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
    `<Event><![CDATA[${event}]]></Event><EventKey><![CDATA[${eventKey}]]></EventKey></xml>`
  );
}

async function seedKeywordReply(keyword: string, text: string): Promise<void> {
  await reply.create(ctx(), {
    triggerKind: 'keyword',
    keyword,
    matchMode: 'exact',
    replyType: 'text',
    payload: { text },
    isEnabled: true,
    sortOrder: 0,
  });
}

// ---------------------------------------------------------------------------
// the callback
// ---------------------------------------------------------------------------

describe('the URL verification handshake', () => {
  it('echoes echostr when the signature is right', async () => {
    const query = { ...plainQuery(), echostr: '5935446184556592210' };
    await expect(verifyUrl(harness.ctx, query)).resolves.toEqual({
      status: 200,
      body: '5935446184556592210',
    });
  });

  it('refuses to echo anything when it is wrong', async () => {
    // Echoing unconditionally — which every tutorial shows — means the URL
    // "works" with the wrong token and then no message ever arrives.
    const query = { ...plainQuery(), signature: 'deadbeef', echostr: 'anything' };
    await expect(verifyUrl(harness.ctx, query)).resolves.toEqual({
      status: 403,
      body: 'invalid signature',
    });
  });
});

describe('a bad signature is rejected before any parsing side effect', () => {
  it('records nothing and answers 403', async () => {
    await seedKeywordReply('优惠券', '这是优惠券');
    const code = await qrcode.create(ctx(), {
      name: '海报',
      scene: 'CH_FORGED',
      expireSeconds: 0,
    });

    const forged = await handleEvent(harness.ctx, {
      query: { ...plainQuery(), signature: 'deadbeef' },
      body: eventMessage('subscribe', 'qrscene_CH_FORGED'),
    });

    expect(forged).toEqual({ status: 403, body: 'invalid signature' });
    // The whole point: an unsigned "this user just subscribed" must not create
    // the follow, the scan or the counter that a coupon rule would read.
    const scans = await harness.ctx.db.select().from(wechatQrcodeScans);
    expect(scans).toHaveLength(0);
    const fresh = await qrcode.detail(ctx(), { id: code.id });
    expect(fresh.scanCount).toBe(0);
    expect(fresh.followCount).toBe(0);
  });

  it('refuses a safe-mode envelope whose msg_signature does not cover it', async () => {
    const encrypted = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: oa.appId,
      message: textMessage('优惠券'),
    });
    const signed = plainQuery();
    const query = {
      ...signed,
      encrypt_type: 'aes',
      // Signed over *a different* ciphertext, which is exactly the replay the
      // `msg_signature` binding exists to stop.
      msg_signature: signatureOf([TOKEN, signed.timestamp, signed.nonce, 'SOMETHING ELSE']),
    };
    await expect(
      handleEvent(harness.ctx, {
        query,
        body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
      }),
    ).resolves.toEqual({ status: 403, body: 'invalid signature' });
  });

  it('refuses a message encrypted for another Official Account', async () => {
    const encrypted = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: 'wxSOMEBODYELSE001',
      message: textMessage('优惠券'),
    });
    const signed = plainQuery();
    const result = await handleEvent(harness.ctx, {
      query: {
        ...signed,
        encrypt_type: 'aes',
        msg_signature: signatureOf([TOKEN, signed.timestamp, signed.nonce, encrypted]),
      },
      body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    });
    expect(result.status).toBe(403);
  });
});

describe('a replay replies once', () => {
  it('answers the same reply twice but counts one scan', async () => {
    await seedKeywordReply('优惠券', '点击领取优惠券');

    const delivery = { query: plainQuery(), body: textMessage('优惠券') };
    const first = await handleEvent(harness.ctx, delivery);
    const second = await handleEvent(harness.ctx, delivery);

    expect(first.body).toContain('点击领取优惠券');
    // WeChat re-delivers whatever it did not get `success` for within five
    // seconds. The customer must still see the reply — and the work must not run
    // a second time.
    expect(second.body).toBe(first.body);
  });

  it('records one follow and one scan for four deliveries of one event', async () => {
    const code = await qrcode.create(ctx(), {
      name: '朝阳门店海报',
      scene: 'CH_REPLAY',
      expireSeconds: 0,
    });
    const delivery = { query: plainQuery(), body: eventMessage('subscribe', 'qrscene_CH_REPLAY') };

    for (let i = 0; i < 4; i += 1) {
      const result = await handleEvent(harness.ctx, delivery);
      expect(result.status).toBe(200);
    }

    const scans = await harness.ctx.db.select().from(wechatQrcodeScans);
    expect(scans).toHaveLength(1);
    const fresh = await qrcode.detail(ctx(), { id: code.id });
    expect(fresh.scanCount).toBe(1);
    expect(fresh.followCount).toBe(1);
  });

  it('treats a follow and the scan a second later as two events', async () => {
    await qrcode.create(ctx(), { name: '海报', scene: 'CH_TWICE', expireSeconds: 0 });
    // Same sender, one second apart, different event: two callbacks, and the
    // dedupe key has to keep them apart or the second is silently dropped.
    await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('subscribe', 'qrscene_CH_TWICE', '1767668400'),
    });
    await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('SCAN', 'CH_TWICE', '1767668401'),
    });

    // Both were processed; the second scan is inside the dedupe window, so the
    // counter still reads 1 — that window is about the *poster*, not the retry.
    const rows = await harness.ctx.db.select().from(wechatQrcodeScans);
    expect(rows).toHaveLength(1);
  });
});

describe('the reply engine', () => {
  it('prefers an exact keyword over a contains rule', async () => {
    await reply.create(ctx(), {
      triggerKind: 'keyword',
      keyword: '优惠',
      matchMode: 'contains',
      replyType: 'text',
      payload: { text: '模糊匹配' },
      isEnabled: true,
      sortOrder: 0,
    });
    await reply.create(ctx(), {
      triggerKind: 'keyword',
      keyword: '优惠券',
      matchMode: 'exact',
      replyType: 'text',
      payload: { text: '精确匹配' },
      isEnabled: true,
      sortOrder: 99,
    });

    const result = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: textMessage('优惠券'),
    });
    expect(result.body).toContain('精确匹配');
  });

  it('falls back to the default reply, and to nothing when there is none', async () => {
    await expect(
      handleEvent(harness.ctx, { query: plainQuery(), body: textMessage('无人认领') }),
    ).resolves.toEqual({ status: 200, body: 'success' });

    await reply.create(ctx(), {
      triggerKind: 'default',
      replyType: 'text',
      payload: { text: '暂未理解，回复「人工」联系客服' },
      isEnabled: true,
      sortOrder: 0,
    });
    const answered = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: textMessage('无人认领', '24000000000000002'),
    });
    expect(answered.body).toContain('暂未理解');
  });

  it('ignores a disabled rule', async () => {
    const rule = await reply.create(ctx(), {
      triggerKind: 'keyword',
      keyword: '优惠券',
      matchMode: 'exact',
      replyType: 'text',
      payload: { text: '关掉了' },
      isEnabled: true,
      sortOrder: 0,
    });
    await reply.setStatus(ctx(), { id: rule.id }, { isEnabled: false });

    await expect(
      handleEvent(harness.ctx, { query: plainQuery(), body: textMessage('优惠券') }),
    ).resolves.toEqual({ status: 200, body: 'success' });
  });

  it('matches a menu tap against the keyword rules', async () => {
    await seedKeywordReply('CONTACT', '客服电话 400-000-0000');
    const result = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('CLICK', 'CONTACT'),
    });
    expect(result.body).toContain('400-000-0000');
  });

  it('answers a subscribe with the greeting and marks the identity followed', async () => {
    const [user] = await harness.ctx.db
      .insert(users)
      .values({ account: 'oa-follower' })
      .returning({ id: users.id });
    await harness.ctx.db.insert(wechatIdentities).values({
      userId: user!.id,
      platform: 'oa',
      openid: OPENID,
      subscribed: false,
    });
    await reply.create(ctx(), {
      triggerKind: 'subscribe',
      replyType: 'text',
      payload: { text: '欢迎关注' },
      isEnabled: true,
      sortOrder: 0,
    });

    const result = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('subscribe'),
    });
    expect(result.body).toContain('欢迎关注');

    const [identity] = await harness.ctx.db
      .select()
      .from(wechatIdentities)
      .where(eq(wechatIdentities.openid, OPENID));
    expect(identity?.subscribed).toBe(true);
    expect(identity?.subscribedAt).not.toBeNull();
  });

  it('records an unsubscribe and says nothing back', async () => {
    const [user] = await harness.ctx.db
      .insert(users)
      .values({ account: 'oa-leaver' })
      .returning({ id: users.id });
    await harness.ctx.db
      .insert(wechatIdentities)
      .values({ userId: user!.id, platform: 'oa', openid: OPENID, subscribed: true });

    const result = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('unsubscribe'),
    });
    expect(result.body).toBe('success');

    const [identity] = await harness.ctx.db
      .select()
      .from(wechatIdentities)
      .where(eq(wechatIdentities.openid, OPENID));
    expect(identity?.subscribed).toBe(false);
  });

  it('mirrors the request’s encryption in the reply', async () => {
    await configure({ messageMode: 'safe' });
    await seedKeywordReply('优惠券', '点击领取优惠券');

    const encrypted = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: oa.appId,
      message: textMessage('优惠券'),
    });
    const signed = plainQuery();
    const result = await handleEvent(harness.ctx, {
      query: {
        ...signed,
        encrypt_type: 'aes',
        msg_signature: signatureOf([TOKEN, signed.timestamp, signed.nonce, encrypted]),
      },
      body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    });

    // The answer is an envelope, not the plain reply: an account in 安全模式
    // rejects plaintext and shows the customer 该公众号暂时无法提供服务.
    expect(result.body).toContain('<Encrypt>');
    expect(result.body).toContain('<MsgSignature>');
    expect(result.body).not.toContain('点击领取优惠券');
  });

  it('counts a scan of a code whose scene nobody recognises as nothing at all', async () => {
    // A poster printed before a code was deleted still gets scanned; inventing a
    // row for it would corrupt the channel report.
    const result = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('SCAN', 'CH_LONG_GONE'),
    });
    expect(result.body).toBe('success');
    expect(await harness.ctx.db.select().from(wechatQrcodeScans)).toHaveLength(0);
  });

  it('still counts a scan of a disabled code, but says nothing', async () => {
    const code = await qrcode.create(ctx(), {
      name: '停用海报',
      scene: 'CH_OFF',
      expireSeconds: 0,
      replyType: 'text',
      replyPayload: { text: '不该出现' },
    });
    await qrcode.setStatus(ctx(), { id: code.id }, { status: 'disabled' });

    const result = await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('SCAN', 'CH_OFF'),
    });
    expect(result.body).toBe('success');
    const fresh = await qrcode.detail(ctx(), { id: code.id });
    expect(fresh.scanCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the menu
// ---------------------------------------------------------------------------

describe('menu publish', () => {
  const tree = [
    {
      name: '商城',
      sub_button: [{ name: '首页', type: 'view' as const, url: 'https://shop.example.test/' }],
    },
  ];

  it('sends the tree to WeChat and only then marks the row live', async () => {
    const draft = await menu.create(ctx(), { name: '默认菜单', buttons: tree });
    expect(draft.isActive).toBe(false);

    const published = await menu.publish(ctx(), { id: draft.id });
    expect(published.isActive).toBe(true);
    expect(published.publishedAt).not.toBeNull();
    expect(published.publishError).toBeNull();
    expect(oa.publishedMenu).toEqual(tree);
    expect(oa.callsTo('/cgi-bin/menu/create')).toHaveLength(1);
  });

  it('leaves publishError and nothing else when WeChat refuses', async () => {
    const draft = await menu.create(ctx(), { name: '默认菜单', buttons: tree });
    oa.behaviour.failMenu = { errcode: 40017, errmsg: 'invalid button type' };

    await expect(menu.publish(ctx(), { id: draft.id })).rejects.toThrow(/40017/);

    const [row] = await harness.ctx.db
      .select()
      .from(wechatOaMenus)
      .where(eq(wechatOaMenus.id, Number(draft.id)));
    // The order is the whole point: a row saying 已发布 for a menu the followers
    // never saw is worse than no row at all.
    expect(row?.isActive).toBe(false);
    expect(row?.publishedAt).toBeNull();
    expect(row?.publishError).toContain('40017');
    // WeChat's English errmsg is in the log, not on 公众号菜单 (AGENTS rule 1).
    expect(row?.publishError).not.toContain('invalid button type');
    expect(row?.publishErrorSummary).toBe('菜单里有按钮的类型不对（错误码 40017）');
  });

  it('tells staff why in Chinese, and never stores WeChat’s errmsg', async () => {
    const draft = await menu.create(ctx(), { name: '默认菜单', buttons: tree });

    oa.behaviour.failMenu = { errcode: 45999, errmsg: 'something new' };
    const refused = await menu.publish(ctx(), { id: draft.id }).catch((error: unknown) => error);
    // The toast reads the error's message: the number, never the errmsg.
    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).message).toBe('发布菜单失败（错误码 45999）');
    let [listed] = (await menu.list(ctx(), { page: 1, pageSize: 20 })).items;
    expect(listed?.publishError).toContain('45999');
    expect(listed?.publishError).not.toContain('something new');
    expect(listed).toMatchObject({
      publishErrorSummary: '微信没有接受这套菜单（错误码 45999），请联系技术人员查看服务器日志',
    });

    // A credential refusal comes from the token, before menu/create is called.
    oa.behaviour.failMenu = null;
    await harness.ctx.config.set(wechatConfig, {
      oaAppId: oa.appId,
      oaAppSecret: 'not-the-secret',
      apiBaseUrl: oa.url,
    });
    await flushTestRedis(harness.redis);
    await expect(menu.publish(ctx(), { id: draft.id })).rejects.toThrow();
    [listed] = (await menu.list(ctx(), { page: 1, pageSize: 20 })).items;
    expect(listed?.publishErrorSummary).toBe('AppID 不正确（错误码 40013）');
    expect(listed?.publishError).toContain('40013');
    expect(listed?.publishError).not.toContain('invalid appid');

    // Accepted at last: both go.
    await configure();
    const published = await menu.publish(ctx(), { id: draft.id });
    expect(published).toMatchObject({ publishError: null, publishErrorSummary: null });
  });

  it('moves the live flag to the newly published menu', async () => {
    const first = await menu.create(ctx(), { name: '一月菜单', buttons: tree });
    await menu.publish(ctx(), { id: first.id });
    const second = await menu.create(ctx(), { name: '春节菜单', buttons: tree });
    await menu.publish(ctx(), { id: second.id });

    const current = await menu.current(ctx());
    expect(current?.id).toBe(second.id);
    const rows = await harness.ctx.db.select().from(wechatOaMenus);
    expect(rows.filter((row) => row.isActive)).toHaveLength(1);
  });

  it('refuses to delete the live menu and allows deleting a draft', async () => {
    const live = await menu.create(ctx(), { name: '线上菜单', buttons: tree });
    await menu.publish(ctx(), { id: live.id });
    await expect(menu.remove(ctx(), { id: live.id })).rejects.toThrow(/不能删除/);

    const draft = await menu.create(ctx(), { name: '草稿', buttons: tree });
    await expect(menu.remove(ctx(), { id: draft.id })).resolves.toBeUndefined();
  });

  it('refuses to publish for a shop that has configured no account', async () => {
    const draft = await menu.create(ctx(), { name: '默认菜单', buttons: tree });
    // The app id lives in the `wechat` group alone, so blanking it there is
    // what "this shop has no Official Account" means.
    await harness.ctx.config.set(wechatConfig, { oaAppId: '' });

    await expect(menu.publish(ctx(), { id: draft.id })).rejects.toThrow(
      /WECHAT_OA_NOT_CONFIGURED|未配置|公众号/,
    );
    // And it refused before it called: a 502 from WeChat reads like an outage.
    expect(oa.callsTo('/cgi-bin/menu/create')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// auto replies
// ---------------------------------------------------------------------------

describe('auto-reply rules', () => {
  it('refuses a second subscribe greeting with a readable error', async () => {
    const form = {
      triggerKind: 'subscribe' as const,
      replyType: 'text' as const,
      payload: { text: '欢迎' },
      isEnabled: true,
      sortOrder: 0,
    };
    await reply.create(ctx(), form);
    await expect(reply.create(ctx(), form)).rejects.toThrow(
      /WECHAT_OA_REPLY_DUPLICATE|已存在|重复/,
    );
  });

  it('refuses a keyword another live rule already owns, and frees it on delete', async () => {
    const first = await reply.create(ctx(), {
      triggerKind: 'keyword',
      keyword: '优惠券',
      matchMode: 'exact',
      replyType: 'text',
      payload: { text: '一' },
      isEnabled: true,
      sortOrder: 0,
    });
    await expect(
      reply.create(ctx(), {
        triggerKind: 'keyword',
        keyword: '优惠券',
        matchMode: 'contains',
        replyType: 'text',
        payload: { text: '二' },
        isEnabled: true,
        sortOrder: 0,
      }),
    ).rejects.toThrow(/WECHAT_OA_KEYWORD_TAKEN|已被|关键词/);

    await reply.remove(ctx(), { id: first.id });
    await expect(
      reply.create(ctx(), {
        triggerKind: 'keyword',
        keyword: '优惠券',
        matchMode: 'exact',
        replyType: 'text',
        payload: { text: '二' },
        isEnabled: true,
        sortOrder: 0,
      }),
    ).resolves.toMatchObject({ keyword: '优惠券' });
  });

  it('lists by trigger and hides a deleted rule', async () => {
    const rule = await reply.create(ctx(), {
      triggerKind: 'keyword',
      keyword: '发货',
      matchMode: 'exact',
      replyType: 'text',
      payload: { text: '48 小时内发货' },
      isEnabled: true,
      sortOrder: 0,
    });
    const listed = await reply.list(ctx(), { page: 1, pageSize: 20, triggerKind: 'keyword' });
    expect(listed.total).toBe(1);

    await reply.remove(ctx(), { id: rule.id });
    const after = await reply.list(ctx(), { page: 1, pageSize: 20 });
    expect(after.total).toBe(0);
    const rows = await harness.ctx.db.select().from(wechatAutoReplies);
    // Soft delete: the row stays, which is what keeps a keyword's history.
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// channel QR codes
// ---------------------------------------------------------------------------

describe('channel QR codes', () => {
  it('asks WeChat first and records the ticket it answered with', async () => {
    const code = await qrcode.create(ctx(), {
      name: '朝阳门店海报',
      scene: 'CH_SHOP_1',
      expireSeconds: 0,
    });
    expect(oa.scenes).toEqual(['CH_SHOP_1']);
    expect(code.ticket).toBe('TICKET_CH_SHOP_1');
    expect(code.imageUrl).toContain('showqrcode?ticket=TICKET_CH_SHOP_1');
    expect(code.expiresAt).toBeNull();
  });

  it('generates a scene when none is given, and never reuses one', async () => {
    const first = await qrcode.create(ctx(), { name: '一', expireSeconds: 0 });
    const second = await qrcode.create(ctx(), { name: '二', expireSeconds: 0 });
    expect(first.scene).not.toBe(second.scene);
    expect(first.scene).toMatch(/^CH_[A-Z0-9]+$/);
  });

  it('refuses a scene that is already taken, even by a deleted code', async () => {
    const code = await qrcode.create(ctx(), { name: '一', scene: 'CH_TAKEN', expireSeconds: 0 });
    await qrcode.remove(ctx(), { id: code.id });
    // The poster is still on a wall, so the scene must never be handed out
    // again — otherwise its scans land in a different channel's report.
    await expect(
      qrcode.create(ctx(), { name: '二', scene: 'CH_TAKEN', expireSeconds: 0 }),
    ).rejects.toThrow(/WECHAT_OA_QRCODE_SCENE_TAKEN|场景/);
  });

  it('keeps the scene out of the edit path', async () => {
    const code = await qrcode.create(ctx(), { name: '一', scene: 'CH_FIXED', expireSeconds: 0 });
    const updated = await qrcode.update(ctx(), { id: code.id }, { name: '改名了' });
    expect(updated.name).toBe('改名了');
    expect(updated.scene).toBe('CH_FIXED');
  });

  it('dates a temporary code from the expiry WeChat was asked for', async () => {
    const code = await qrcode.create(ctx(), { name: '活动码', expireSeconds: 604_800 });
    expect(code.expiresAt).toBe(new Date(Date.parse(NOW) + 604_800_000).toISOString());
  });

  it('refuses to delete a category that still holds codes', async () => {
    const category = await qrcode.createCategory(ctx(), { name: '线下门店', sortOrder: 0 });
    const code = await qrcode.create(ctx(), {
      name: '海报',
      categoryId: category.id,
      expireSeconds: 0,
    });
    await expect(qrcode.deleteCategory(ctx(), { id: category.id })).rejects.toThrow(
      /WECHAT_OA_CATEGORY_NOT_EMPTY|还有|分类/,
    );

    await qrcode.remove(ctx(), { id: code.id });
    await expect(qrcode.deleteCategory(ctx(), { id: category.id })).resolves.toBeUndefined();
  });

  it('frees a deleted category’s name for reuse', async () => {
    // A code's scene must stay taken for ever — the poster is on a wall. A
    // *category* name is only a label in an admin dropdown, so the opposite is
    // true: 地推 deleted in March has to be available again in April. The
    // unique index is partial on `deleted_at is null` for exactly this.
    const first = await qrcode.createCategory(ctx(), { name: '地推', sortOrder: 0 });
    await expect(qrcode.createCategory(ctx(), { name: '地推', sortOrder: 1 })).rejects.toThrow(
      /WECHAT_OA_CATEGORY_NAME_TAKEN|已被占用/,
    );

    await qrcode.deleteCategory(ctx(), { id: first.id });
    const second = await qrcode.createCategory(ctx(), { name: '地推', sortOrder: 1 });
    expect(second.id).not.toBe(first.id);

    // And the old row stays deleted rather than being resurrected under the
    // new name, so its historical codes keep pointing where they pointed.
    const listed = await qrcode.listCategories(ctx(), { page: 1, pageSize: 20 });
    expect(listed.items.filter((item) => item.name === '地推').map((item) => item.id)).toEqual([
      second.id,
    ]);
  });

  it('reports scans per day and masks the openid', async () => {
    const code = await qrcode.create(ctx(), { name: '海报', scene: 'CH_STAT', expireSeconds: 0 });
    await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('subscribe', 'qrscene_CH_STAT'),
    });

    const stat = await qrcode.statistic(ctx(), { id: code.id }, {});
    expect(stat.scanCount).toBe(1);
    expect(stat.followCount).toBe(1);
    expect(stat.uniqueScanners).toBe(1);
    expect(stat.points).toEqual([{ date: '2026-06-01', scans: 1, newFollowers: 1 }]);

    const scans = await qrcode.scans(ctx(), { id: code.id }, { page: 1, pageSize: 20 });
    expect(scans.items[0]?.openid).toBe('oABC****WXYZ');
    expect(scans.items[0]?.isNewFollower).toBe(true);
  });

  it('counts the same phone twice once the dedupe window has passed', async () => {
    const code = await qrcode.create(ctx(), { name: '海报', scene: 'CH_WINDOW', expireSeconds: 0 });
    await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('SCAN', 'CH_WINDOW', '1767668400'),
    });
    // Redis holds the window, so expiring it is how time passes here.
    await harness.redis.del(`wechat-oa:scan:${Number(code.id)}:${OPENID}`);
    await handleEvent(harness.ctx, {
      query: plainQuery(),
      body: eventMessage('SCAN', 'CH_WINDOW', '1767668999'),
    });

    const fresh = await qrcode.detail(ctx(), { id: code.id });
    expect(fresh.scanCount).toBe(2);
    expect(fresh.followCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// material
// ---------------------------------------------------------------------------

describe('the material library', () => {
  /**
   * An attachment whose bytes are really in storage, because `upload` reads
   * them back by storage key — which is the point of taking an attachment id
   * rather than a file.
   */
  async function seedAttachment(mime = 'image/png', size?: number): Promise<string> {
    const stored = await harness.storage.put(Buffer.from('not really a png'), {
      contentType: mime,
      filename: 'banner.png',
    });
    const [row] = await harness.ctx.db
      .insert(attachments)
      .values({
        name: 'banner.png',
        storageKey: stored.key,
        driver: 'local',
        kind: 'image',
        sha256: stored.sha256,
        url: `https://shop.example.test/${stored.key}`,
        mime,
        // The size the *row* claims, which is what the rule checks — a test for
        // the 10 MB refusal must not write 10 MB.
        size: size ?? stored.size,
      })
      .returning({ id: attachments.id });
    return String(row!.id);
  }

  it('pushes an attachment we already hold and records the handle', async () => {
    const attachmentId = await seedAttachment();
    const medium = await media.upload(ctx(), { attachmentId, kind: 'image', isPermanent: true });

    expect(medium.mediaId).toMatch(/^PERM_MEDIA_/);
    expect(medium.attachmentId).toBe(attachmentId);
    expect(medium.expiresAt).toBeNull();
    expect(oa.callsTo('/cgi-bin/material/add_material')).toHaveLength(1);
  });

  it('recovers from a dead cached token by itself, as every other WeChat call does', async () => {
    // An upload that called `fetch` with a token it fetched once would surface
    // a token WeChat had already rotated as `WECHAT_OA_API_FAILED 40001`.
    // Through the client's `upload` it is dropped and the call retried once.
    await harness.redis.set(`wechat:access-token:${oa.appId}`, 'ROTATED_AWAY', 'PX', 60_000);
    const attachmentId = await seedAttachment();

    const medium = await media.upload(ctx(), { attachmentId, kind: 'image', isPermanent: true });

    expect(medium.mediaId).toMatch(/^PERM_MEDIA_/);
    const calls = oa.callsTo('/cgi-bin/material/add_material');
    expect(calls.map((call) => call.query['access_token'])).toEqual([
      'ROTATED_AWAY',
      expect.not.stringMatching(/^ROTATED_AWAY$/),
    ]);
    expect(calls.every((call) => call.query['type'] === 'image')).toBe(true);
    expect(await harness.redis.get(`wechat:access-token:${oa.appId}`)).not.toBe('ROTATED_AWAY');
  });

  it('dates a temporary asset three days out', async () => {
    const attachmentId = await seedAttachment();
    const medium = await media.upload(ctx(), { attachmentId, kind: 'image', isPermanent: false });
    expect(medium.expiresAt).toBe(new Date(Date.parse(NOW) + 3 * 86_400_000).toISOString());
  });

  it('refuses a MIME type or a size WeChat would refuse, before uploading', async () => {
    const pdf = await seedAttachment('application/pdf');
    await expect(
      media.upload(ctx(), { attachmentId: pdf, kind: 'image', isPermanent: true }),
    ).rejects.toThrow(/不支持/);

    const huge = await seedAttachment('image/png', 11 * 1024 * 1024);
    await expect(
      media.upload(ctx(), { attachmentId: huge, kind: 'image', isPermanent: true }),
    ).rejects.toThrow(/不能超过/);
    expect(oa.callsTo('/cgi-bin/material/add_material')).toHaveLength(0);
  });

  it('reconciles in one direction: WeChat is the truth about what exists', async () => {
    const attachmentId = await seedAttachment();
    const ours = await media.upload(ctx(), { attachmentId, kind: 'image', isPermanent: true });
    // One handle WeChat has and we do not, and one of ours it has forgotten.
    oa.addMaterial({ mediaId: 'PERM_FROM_MP', kind: 'image', url: 'https://mmbiz.qpic.cn/x' });
    oa.material.delete(ours.mediaId);

    const result = await media.sync(ctx());
    expect(result).toEqual({ removed: 1, added: 1, unchanged: 0 });

    const listed = await media.list(ctx(), { page: 1, pageSize: 20 });
    expect(listed.items.map((item) => item.mediaId)).toEqual(['PERM_FROM_MP']);
  });

  it('drops our row when WeChat has already forgotten the handle', async () => {
    const attachmentId = await seedAttachment();
    const medium = await media.upload(ctx(), { attachmentId, kind: 'image', isPermanent: true });
    oa.material.delete(medium.mediaId); // the fake then answers 40007

    await expect(media.remove(ctx(), { id: medium.id })).resolves.toBeUndefined();
    const listed = await media.list(ctx(), { page: 1, pageSize: 20 });
    expect(listed.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the storefront pair
// ---------------------------------------------------------------------------

describe('the JS-SDK signature', () => {
  it('signs a page on the shop’s own host and caches the ticket', async () => {
    const config = await storefront.jssdkConfigFor(harness.ctx, {
      url: 'https://shop.example.test/pages/index?from=wx#fragment',
    });
    expect(config.appId).toBe(oa.appId);
    expect(config.signature).toMatch(/^[0-9a-f]{40}$/);

    await storefront.jssdkConfigFor(harness.ctx, { url: 'https://shop.example.test/other' });
    // The ticket endpoint is rate-limited hard and every page view of an H5
    // storefront asks for a signature.
    expect(oa.callsTo('/cgi-bin/ticket/getticket')).toHaveLength(1);
    expect(await harness.redis.get(`wechat:jsapi-ticket:${oa.appId}`)).toMatch(/^JSAPI_TICKET_/);
  });

  it('refuses to sign somebody else’s page', async () => {
    await expect(
      storefront.jssdkConfigFor(harness.ctx, { url: 'https://attacker.test/p' }),
    ).rejects.toThrow(/WECHAT_OA_URL_NOT_ALLOWED|不允许|地址/);
  });

  it('signs a host the operator listed', async () => {
    await harness.ctx.config.set(wechatOaRuntimeConfig, { jsApiAllowedHosts: 'm.example.test' });
    await expect(
      storefront.jssdkConfigFor(harness.ctx, { url: 'https://m.example.test/p' }),
    ).resolves.toMatchObject({ appId: oa.appId });
  });
});

describe('subscribe template ids', () => {
  it('splits, trims and de-duplicates the configured list', async () => {
    await expect(
      storefront.subscribeTemplatesFor(harness.ctx, { scene: 'order-pay' }),
    ).resolves.toEqual({ templateIds: ['TPL_PAY_1', 'TPL_PAY_2'] });
  });

  it('answers an empty list for a scene nobody configured', async () => {
    await expect(
      storefront.subscribeTemplatesFor(harness.ctx, { scene: 'refund' }),
    ).resolves.toEqual({ templateIds: [] });
  });
});
