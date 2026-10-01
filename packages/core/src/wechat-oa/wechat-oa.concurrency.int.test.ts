import { wechatAutoReplies, wechatOaMenus, wechatQrcodeScans } from '@shop/db/schema/wechat';
import { createTestCtx, flushTestRedis, runConcurrently, type TestCtx } from '@shop/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import { wechatOaConfig } from '../system';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import { jsapiTicketCacheKey, resetJsapiTicketFlight } from './wechat-oa.client';
import { wechatOaRuntimeConfig } from './wechat-oa.config';
import { signatureOf } from './wechat-oa.crypto';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import * as menu from './wechat-oa.menu.service';
import * as qrcode from './wechat-oa.qrcode.service';
import * as reply from './wechat-oa.reply.service';
import * as storefront from './wechat-oa.storefront.service';
import { handleEvent } from './wechat-oa.webhook.service';

/**
 * Every state change in this domain that is conditional on something read a
 * moment earlier, run as a race.
 *
 * WeChat makes this less theoretical than usual. The callback URL is fanned out
 * by WeChat's own servers, which re-deliver an event up to four times *while*
 * the first delivery is still being handled, so "two requests at once" is the
 * normal case rather than the unlucky one: a poster with a QR code on it
 * produces a scan and a follow one second apart from two different connections,
 * and a shop with more than one Node process gets them in two processes.
 *
 * Each test below asserts the count, never the winner. Which operator's publish
 * wins is a matter of who clicked last; how many menus are live afterwards is
 * an invariant.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const TOKEN = 'shoptoken';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const GH = 'gh_1234567890ab';

const admin: Actor = { kind: 'admin', id: 1, permissions: [], isSuper: true };

function ctx(): Ctx {
  return harness.ctx.as(admin);
}

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, actor: admin });
  oa = await startFakeOaServer();
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
  resetJsapiTicketFlight();

  await harness.ctx.config.set(wechatConfig, {
    oaAppId: oa.appId,
    oaAppSecret: oa.appSecret,
    apiBaseUrl: oa.url,
  });
  await harness.ctx.config.set(wechatOaConfig, {
    enabled: true,
    token: TOKEN,
    encodingAesKey: AES_KEY,
    messageMode: 'plain',
  });
  await harness.ctx.config.set(wechatOaRuntimeConfig, {
    jsApiAllowedHosts: '',
    scanDedupeSeconds: 300,
  });
});

// ---------------------------------------------------------------------------
// callback fixtures
// ---------------------------------------------------------------------------

/** Signed at `NOW` with a nonce of its own — the callback spends each triple on one body. */
let nonceSeq = 1372623149;
function plainQuery(timestamp = String(NOW_SECONDS), nonce = String((nonceSeq += 1))) {
  return { timestamp, nonce, signature: signatureOf([TOKEN, timestamp, nonce]) };
}

function scanEvent(scene: string, openid: string, createTime = '1767668400'): string {
  return (
    `<xml><ToUserName><![CDATA[${GH}]]></ToUserName>` +
    `<FromUserName><![CDATA[${openid}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
    `<Event><![CDATA[SCAN]]></Event><EventKey><![CDATA[${scene}]]></EventKey></xml>`
  );
}

const menuTree = (label: string) => [
  { name: label, type: 'view' as const, url: 'https://shop.example.test/' },
];

// ---------------------------------------------------------------------------
// the menu
// ---------------------------------------------------------------------------

describe('publishing two menus at once', () => {
  it('leaves exactly one live menu', async () => {
    const drafts = await Promise.all([
      menu.create(ctx(), { name: '春季', buttons: menuTree('春季') }),
      menu.create(ctx(), { name: '夏季', buttons: menuTree('夏季') }),
    ]);

    // `activateMenu` clears every `is_active` and then sets one, in a
    // transaction — but with nothing active yet the first statement matches no
    // rows and therefore locks nothing, so both transactions reach the second
    // statement and `wechat_oa_menus_active_uq` rejects the later one. Losing
    // there would be wrong: WeChat has already accepted that menu and it *is*
    // what the followers see. `publish` retries once, which is why both of
    // these succeed and only one row is live.
    const report = await runConcurrently(2, (index) =>
      menu.publish(ctx(), { id: drafts[index]!.id }),
    );
    expect(report.rejected).toEqual([]);

    const live = await harness.ctx.db
      .select()
      .from(wechatOaMenus)
      .where(eq(wechatOaMenus.isActive, true));
    expect(live).toHaveLength(1);
    expect(drafts.map((draft) => draft.id)).toContain(String(live[0]!.id));
    // Both were genuinely sent: the retry is about the row, not about WeChat.
    expect(oa.callsTo('/cgi-bin/menu/create')).toHaveLength(2);
  });

  it('leaves exactly one live menu when one is already live', async () => {
    const first = await menu.create(ctx(), { name: '春季', buttons: menuTree('春季') });
    await menu.publish(ctx(), { id: first.id });

    const rest = await Promise.all([
      menu.create(ctx(), { name: '夏季', buttons: menuTree('夏季') }),
      menu.create(ctx(), { name: '秋季', buttons: menuTree('秋季') }),
    ]);
    const report = await runConcurrently(2, (index) =>
      menu.publish(ctx(), { id: rest[index]!.id }),
    );
    expect(report.rejected).toEqual([]);

    const live = await harness.ctx.db
      .select()
      .from(wechatOaMenus)
      .where(eq(wechatOaMenus.isActive, true));
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(Number(first.id));
  });
});

// ---------------------------------------------------------------------------
// auto replies
// ---------------------------------------------------------------------------

describe('two operators saving the same rule', () => {
  it('lets one keyword through and refuses the rest with a 409', async () => {
    const report = await runConcurrently(5, (index) =>
      reply.create(ctx(), {
        triggerKind: 'keyword',
        keyword: '退货',
        matchMode: 'exact',
        replyType: 'text',
        payload: { text: `第 ${index} 版` },
        isEnabled: true,
        sortOrder: 0,
      }),
    );

    expect(report.fulfilled).toHaveLength(1);
    // Not a 500: `assertFree` reads and then writes, and the index is what
    // actually decides. The loser has to read 该关键词已被其他自动回复占用.
    expect(report.rejected).toHaveLength(4);
    for (const error of report.rejected) {
      expect(String(error)).toMatch(/WECHAT_OA_KEYWORD_TAKEN|关键词/);
    }

    const rows = await harness.ctx.db.select().from(wechatAutoReplies);
    expect(rows).toHaveLength(1);
  });

  it('keeps the subscribe greeting a singleton', async () => {
    const report = await runConcurrently(4, (index) =>
      reply.create(ctx(), {
        triggerKind: 'subscribe',
        replyType: 'text',
        payload: { text: `欢迎 ${index}` },
        isEnabled: true,
        sortOrder: 0,
      }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(3);
    for (const error of report.rejected) {
      expect(String(error)).toMatch(/WECHAT_OA_REPLY_DUPLICATE|已存在/);
    }
  });

  it('deletes a rule once, however many people click 删除', async () => {
    const rule = await reply.create(ctx(), {
      triggerKind: 'keyword',
      keyword: '发货',
      matchMode: 'exact',
      replyType: 'text',
      payload: { text: '48 小时内发货' },
      isEnabled: true,
      sortOrder: 0,
    });

    const report = await runConcurrently(5, () => reply.remove(ctx(), { id: rule.id }));
    // `softDeleteReply` is a conditional update on `deleted_at is null`, so the
    // four losers get the 404 that tells the admin to refresh rather than a
    // silent success over a row that is already gone.
    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(4);
    for (const error of report.rejected) {
      expect(String(error)).toMatch(/WECHAT_OA_REPLY_NOT_FOUND|不存在/);
    }
  });
});

// ---------------------------------------------------------------------------
// channel QR codes
// ---------------------------------------------------------------------------

describe('channel codes created at once', () => {
  it('hands the scene string to exactly one of them', async () => {
    const report = await runConcurrently(3, (index) =>
      qrcode.create(ctx(), { name: `海报 ${index}`, scene: 'CH_RACE', expireSeconds: 0 }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(2);
    for (const error of report.rejected) {
      expect(String(error)).toMatch(/WECHAT_OA_QRCODE_SCENE_TAKEN|场景/);
    }
    // A scene handed out twice is two posters reporting into one row, which no
    // later report can untangle.
    const listed = await qrcode.list(ctx(), { page: 1, pageSize: 20 });
    expect(listed.total).toBe(1);
  });

  it('never generates the same scene twice', async () => {
    const report = await runConcurrently(8, (index) =>
      qrcode.create(ctx(), { name: `海报 ${index}`, expireSeconds: 0 }),
    );
    expect(report.rejected).toEqual([]);
    const scenes = new Set(report.fulfilled.map((code) => code.scene));
    expect(scenes.size).toBe(8);
  });

  it('names a category once', async () => {
    const report = await runConcurrently(4, () =>
      qrcode.createCategory(ctx(), { name: '地推', sortOrder: 0 }),
    );
    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(3);
    for (const error of report.rejected) {
      expect(String(error)).toMatch(/WECHAT_OA_CATEGORY_NAME_TAKEN|名称/);
    }
  });
});

// ---------------------------------------------------------------------------
// the counters, which is what the whole feature is for
// ---------------------------------------------------------------------------

describe('scans arriving together', () => {
  it('counts every one of them', async () => {
    const code = await qrcode.create(ctx(), {
      name: '朝阳门店海报',
      scene: 'CH_BUSY',
      expireSeconds: 0,
    });

    // Twelve different phones scanning the same poster in the same second, as
    // happens the moment it goes up at an event. `bumpQrcodeCounters` is
    // `SET n = n + 1`; a read-modify-write here would make the counter drift
    // low, and nobody would trust the channel report.
    const report = await runConcurrently(12, (index) =>
      handleEvent(harness.ctx, {
        query: plainQuery(),
        body: scanEvent('CH_BUSY', `oPHONE${String(index).padStart(3, '0')}`),
      }),
    );
    expect(report.rejected).toEqual([]);

    const stat = await qrcode.statistic(ctx(), { id: code.id }, {});
    expect(stat.scanCount).toBe(12);
    expect(stat.uniqueScanners).toBe(12);
    const rows = await harness.ctx.db.select().from(wechatQrcodeScans);
    expect(rows).toHaveLength(12);
  });

  it('counts one phone once, however many deliveries arrive at once', async () => {
    const code = await qrcode.create(ctx(), {
      name: '海报',
      scene: 'CH_RETRY',
      expireSeconds: 0,
    });

    // WeChat re-delivers an unacknowledged callback up to four times, and the
    // retries overlap the first delivery rather than following it. Two guards
    // stand between that and a counter that measures WeChat's patience: the
    // `MsgId`/event dedupe claim and the per-phone scan window. This is the
    // same event four times over, so both should hold.
    const body = scanEvent('CH_RETRY', 'oSAMEPHONE');
    const report = await runConcurrently(4, () =>
      handleEvent(harness.ctx, { query: plainQuery(), body }),
    );
    expect(report.results.every((result) => result.status === 'fulfilled')).toBe(true);

    const stat = await qrcode.statistic(ctx(), { id: code.id }, {});
    expect(stat.scanCount).toBe(1);
    const rows = await harness.ctx.db.select().from(wechatQrcodeScans);
    expect(rows).toHaveLength(1);
  });

  it('counts one phone once when the deliveries differ only in CreateTime', async () => {
    // The dedupe key for an event is `openid:CreateTime:Event`, so a genuinely
    // re-sent scan a second later is a *different* key and only the scan window
    // stops it. This is the test that fails if `scanDedupeSeconds` ever stops
    // being consulted.
    const code = await qrcode.create(ctx(), { name: '海报', scene: 'CH_WIN', expireSeconds: 0 });
    const report = await runConcurrently(5, (index) =>
      handleEvent(harness.ctx, {
        query: plainQuery(),
        body: scanEvent('CH_WIN', 'oSAMEPHONE', String(1767668400 + index)),
      }),
    );
    expect(report.rejected).toEqual([]);

    const stat = await qrcode.statistic(ctx(), { id: code.id }, {});
    expect(stat.scanCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the JS-SDK ticket
// ---------------------------------------------------------------------------

describe('a cold jsapi ticket cache', () => {
  it('refreshes once for all the requests that miss together', async () => {
    // The cache is cold exactly when the shop is busiest — a deploy, a restart,
    // or two hours running out mid-morning — and every H5 page view asks for a
    // signature. Without the shared flight this is one WeChat call per request
    // against an endpoint WeChat rate-limits hard, and the whole storefront
    // loses `wx.chooseWXPay` for the rest of the hour.
    const report = await runConcurrently(10, () =>
      storefront.jssdkConfigFor(harness.ctx, { url: 'https://shop.example.test/pages/index' }),
    );
    expect(report.rejected).toEqual([]);

    expect(oa.callsTo('/cgi-bin/ticket/getticket')).toHaveLength(1);
    expect(oa.callsTo('/cgi-bin/token')).toHaveLength(1);

    const signatures = new Set(report.fulfilled.map((config) => config.signature));
    // Every signature is over a fresh `nonceStr`, so they differ — what they
    // share is the ticket, and that is what the assertion above measures.
    expect(signatures.size).toBe(10);
    expect(await harness.redis.get(jsapiTicketCacheKey(oa.appId))).toMatch(/^JSAPI_TICKET_/);
  });
});
