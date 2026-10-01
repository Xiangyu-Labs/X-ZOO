import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import {
  startUntrustedHttpsServer,
  type UntrustedHttpsServer,
} from './__fixtures__/untrusted-https';
import { createWechatClient } from './wechat.client';
import { wechatConfig } from './wechat.config';

/**
 * TLS-001 for the Official Account and mini-program client (the pay client has
 * `wechat.pay.tls.test.ts`, the refund client `refund.tls.test.ts`).
 *
 * These calls matter more than most for the handshake: `/cgi-bin/token`,
 * `/sns/oauth2/access_token` and `/sns/jscode2session` carry the **AppSecret on
 * the query string**. A client that talked to a host it could not authenticate
 * would hand the secret to whoever answered. So each call is pointed at an
 * HTTPS server whose self-signed certificate nobody trusts and must fail before
 * the request line is sent: the server's `received` stays empty, and the error
 * is Node's certificate refusal rather than anything about the response.
 */

let server: UntrustedHttpsServer;

beforeAll(async () => {
  server = await startUntrustedHttpsServer(new Date());
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.received.length = 0;
});

const noop = (): void => {};

/**
 * Just enough `Ctx` for the client: the `wechat` group pointed at the untrusted
 * host, and a Redis that may already hold a token (so the token-bearing calls
 * are tried without a `/cgi-bin/token` first).
 */
function ctxWith(options: { cachedToken?: string } = {}): Ctx {
  const values = wechatConfig.schema.parse({
    oaAppId: 'wxOA0000000000001',
    oaAppSecret: 'OA_APP_SECRET_NEVER_SENT',
    miniAppId: 'wxMINI00000000001',
    miniAppSecret: 'MINI_APP_SECRET_NEVER_SENT',
    apiBaseUrl: server.url,
  });
  const redis = {
    get: async () => options.cachedToken ?? null,
    set: async () => 'OK',
    del: async () => 1,
  };
  return {
    clock: { now: () => new Date() },
    logger: { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop },
    config: { get: async () => values },
    redis,
  } as unknown as Ctx;
}

/** The certificate refusal, wherever `fetch` put it in the cause chain. */
async function refusedAtHandshake(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'the WeChat client accepted a host it could not authenticate').toBeInstanceOf(
    Error,
  );
  const codes: string[] = [];
  for (let at: unknown = error; at instanceof Error; at = (at as { cause?: unknown }).cause) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
  }
  expect(codes.join(' ')).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
  expect(server.received).toEqual([]);
}

describe('TLS-001 — the OA and mini-program client refuses a host it cannot authenticate', () => {
  it('never sends the OA AppSecret to it: the token refresh stops at the handshake', async () => {
    await refusedAtHandshake(createWechatClient(ctxWith()).accessToken('oa'));
  });

  it('never sends the mini-program AppSecret to it either', async () => {
    await refusedAtHandshake(createWechatClient(ctxWith()).accessToken('mini'));
  });

  it('refuses the OAuth code exchange, which carries the secret too', async () => {
    await refusedAtHandshake(createWechatClient(ctxWith()).oaCodeExchange('CODE'));
  });

  it('refuses the mini-program login the same way', async () => {
    await refusedAtHandshake(createWechatClient(ctxWith()).miniCode2Session('JS_CODE'));
  });

  it('refuses a token-bearing JSON call', async () => {
    const client = createWechatClient(ctxWith({ cachedToken: 'CACHED_TOKEN' }));
    await refusedAtHandshake(
      client.call('oa', { method: 'POST', path: '/cgi-bin/menu/create', body: { button: [] } }),
    );
  });

  it('refuses a binary call (小程序码)', async () => {
    const client = createWechatClient(ctxWith({ cachedToken: 'CACHED_TOKEN' }));
    await refusedAtHandshake(
      client.callBytes('mini', {
        method: 'POST',
        path: '/wxa/getwxacodeunlimit',
        body: { scene: 's', page: 'pages/index/index' },
      }),
    );
  });

  it('refuses a multipart upload (素材)', async () => {
    const client = createWechatClient(ctxWith({ cachedToken: 'CACHED_TOKEN' }));
    await refusedAtHandshake(
      client.upload('oa', {
        path: '/cgi-bin/material/add_material',
        query: { type: 'image' },
        field: 'media',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        filename: 'a.png',
        contentType: 'image/png',
      }),
    );
  });
});
