import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import type { Actor, Ctx } from '../kernel/context';
import { paymentConfig } from '../payment';
import { refundConfig } from '../refund';
import { getWechatClient, resetWechatTokenFlight, wechatConfig } from '../wechat';
import { configGet, configSave } from './config.service';
import { wechatOaConfig } from './wechat-oa.config';
import './index';
import '../domains.gen';

/**
 * The settings screens, read as an attacker holding a *narrow* console role.
 *
 * The contract the config routes promise is: a credential is write-only (the
 * form gets an "is set" boolean), the form writes only the fields it shows, and
 * each group is written only with its own write atom. Each case below is one
 * way round that contract.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-09-22T08:00:00.000Z';

function as(permissions: string[]): Ctx {
  const actor: Actor = { kind: 'admin', id: 7, permissions, isSuper: false };
  return harness.ctx.as(actor);
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
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  oa.reset();
  resetWechatTokenFlight();
});

describe('the OA callback token on the settings screen', () => {
  // `wechat-oa.token` is the whole of the 明文-mode webhook's authentication
  // (`sha1(sort(token, timestamp, nonce))`). As a plain `text` field,
  // `configGet` would hand it to anyone holding `system:config:read` — the
  // lowest settings atom there is — and with it every OA callback body could be
  // forged. So it is a secret, and the registry heuristic in system.test.ts
  // matches `token` to keep it one.
  it('never returns the webhook token to a read-only settings role', async () => {
    await harness.ctx.config.set(wechatOaConfig, { token: 'the-callback-token' });

    const read = await configGet(as(['system:config:read']), { group: 'wechat-oa' });

    expect(JSON.stringify(read)).not.toContain('the-callback-token');
  });
});

describe('a schema key the form never shows', () => {
  // `wechat.apiBaseUrl` has no `ui` entry — it exists so the tests can point
  // the client at a fake. If `configSave` accepted every key of the zod schema,
  // a holder of `payment:config:write` could post it, and `refresh()` would
  // then send `appid` and the stored **AppSecret** on the query string of
  // `GET {apiBaseUrl}/cgi-bin/token`: a write-only credential read back by
  // pointing the server at a host the attacker controls, and an SSRF from the
  // app container while it lasts. The fake OA server stands in for the
  // attacker's host. The same holds for `payment.apiBaseUrl`.
  it('refuses to repoint the WeChat client from the settings form', async () => {
    // The shop is configured the ordinary way, with the real WeChat host.
    await harness.ctx.config.set(wechatConfig, {
      oaAppId: oa.appId,
      oaAppSecret: oa.appSecret,
    });

    const attacker = as(['payment:config:write']);
    await configSave(attacker, { group: 'wechat' }, { values: { apiBaseUrl: oa.url } }).catch(
      () => undefined,
    );
    // Show the secret is not readable through the front door…
    expect(JSON.stringify(await configGet(attacker, { group: 'wechat' }))).not.toContain(
      oa.appSecret,
    );
    // …then take it through the back one: any token refresh will do.
    await getWechatClient(harness.ctx)
      .accessToken('oa')
      .catch(() => undefined);

    const leaked = oa.callsTo('/cgi-bin/token').map((call) => call.query['secret']);
    expect(leaked).not.toContain(oa.appSecret);
  });

  it('refuses to repoint the WeChat Pay client from the settings form', async () => {
    await configSave(
      as(['payment:config:write']),
      { group: 'payment' },
      { values: { apiBaseUrl: 'http://169.254.169.254' } },
    ).catch(() => undefined);

    const stored = await harness.ctx.config.get(paymentConfig);
    expect(stored.apiBaseUrl).toBe('https://api.mch.weixin.qq.com');
  });
});

describe('the 售后设置 group and the 备注 atom', () => {
  // `writePermissionFor` derives a write atom only from a `:read` one. Were
  // `refundConfig.permission` the refund domain's 备注售后单 atom
  // (`refund:request:write`), the remark permission would also be the
  // permission to rewrite the address buyers post their returns to. So the
  // group declares `refund:config:read`, and writing it takes
  // `refund:config:write`.
  it('does not let the remark permission rewrite the return address', async () => {
    await configSave(
      as(['refund:request:write']),
      { group: 'refund' },
      { values: { returnAddress: '别处 1 号' } },
    ).catch(() => undefined);

    const stored = await harness.ctx.config.get(refundConfig);
    expect(stored.returnAddress).toBe('');
  });
});
