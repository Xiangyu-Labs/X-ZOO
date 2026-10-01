import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { FakeWechatGateway } from '@shop/testing';
import type { FakeOaServer } from '@shop/testing/wechat';

/**
 * The bridge between the fake WeChat Pay gateway and a Playwright spec.
 *
 * `startFakeWechatGateway()` returns an in-process object — `scripts/serve.ts`
 * holds it, because that is the process that starts `web` and hands the
 * gateway's URL to `paymentConfig`. A spec runs in a *different* process (the
 * Playwright test runner), so it cannot call `gateway.markPaid()` directly the
 * way `payment.int.test.ts` does in the same process as the code under test.
 *
 * This is a second, tiny HTTP server, started alongside the gateway, that
 * exposes exactly the two operations the eight journeys need performed on the
 * live gateway instance:
 *
 *  - `complete-payment`: marks the transaction paid and delivers the signed
 *    async notification to `web`'s real webhook route, the same two steps a
 *    real WeChat payment completion is — because a shopper's browser can
 *    genuinely create the payment attempt (a real `POST .../payments` call)
 *    but headless Chromium cannot complete a WeChat H5 redirect;
 *  - `complete-refund`: settles a refund's gateway-side state so a spec is
 *    not stuck polling for `reconcileStaleRefunds()`'s sweep interval;
 *
 * It also answers the mini-program's "模拟小程序"
 * build (`apps/mini/src/platform/h5-mp-emulation.tsx`), reached through the
 * edge at `/__e2e/mini/*`. These stand in for what the WeChat client itself
 * does on a phone, and nothing else:
 *
 *  - `mini/login-code` `{ openid, unionid? }`: what `wx.login()` returns — a
 *    fresh single-use code, taught to the fake `api.weixin.qq.com` so the
 *    server's real `jscode2session` call redeems it for that openid;
 *  - `mini/phone-code` `{ phone }`: what the `getPhoneNumber` button returns,
 *    taught to the fake's `getuserphonenumber` the same way;
 *  - `mini/request-payment` `{ package }`: the shopper confirming
 *    `wx.requestPayment` — exactly what a phone hands WeChat, the
 *    `prepay_id=` package and nothing else. The fake gateway maps the
 *    `prepay_id` back to the transaction the server placed (an unknown one
 *    is a 409: a bug in the page, not a payment); then `complete-payment`'s
 *    two steps;
 *  - `mini/confirm-receipt` `{ transactionId } | { merchantId, merchantTradeNo }`:
 *    the shopper tapping 确认收货 in WeChat's own component
 *    (`openBusinessView('weappOrderConfirm')`). WeChat records it on its side,
 *    so the fake's `get_order` answers `order_state` 3 from then on; the
 *    server still has to ask (C07). A payment WeChat was never told about is a
 *    409.
 *
 * Nothing here is a shortcut through domain code: both operations still go
 * through the real webhook route and the real signature the gateway would
 * produce for an actual WeChat notification, so what a spec proves is what
 * production would do once WeChat's own server delivered the callback.
 */

export interface GatewayControlOptions {
  gateway: FakeWechatGateway;
  /** The edge origin — where `notifyBaseUrl` in `paymentConfig` points. */
  baseUrl: string;
  /** The fake `api.weixin.qq.com`; enables the `mini/*` routes. */
  wechat?: FakeOaServer | undefined;
  port?: number;
}

export interface GatewayControl {
  url: string;
  close(): Promise<void>;
}

export async function startGatewayControl(options: GatewayControlOptions): Promise<GatewayControl> {
  const { gateway, baseUrl, wechat } = options;

  /** A code as unguessable as WeChat's, so no two logins ever share one. */
  const mintCode = (kind: string): string => `emu-${kind}-${randomBytes(12).toString('hex')}`;

  async function settle(outTradeNo: string): Promise<unknown> {
    gateway.markPaid(outTradeNo);
    return gateway.postNotify(`${baseUrl}/api/v1/webhooks/wechat-pay`, { outTradeNo });
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body =
        chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : {};

      if (req.method === 'POST' && req.url === '/complete-payment') {
        const { outTradeNo } = body as { outTradeNo: string };
        respond(res, 200, await settle(outTradeNo));
        return;
      }

      if (wechat && req.method === 'POST' && req.url?.startsWith('/mini/')) {
        await handleMini(req.url.slice('/mini/'.length), body, res, wechat);
        return;
      }

      if (req.method === 'POST' && req.url === '/complete-refund') {
        const { outRefundNo } = body as { outRefundNo: string };
        gateway.markRefunded(outRefundNo, 'SUCCESS');
        const result = await gateway.postRefundNotify(`${baseUrl}/api/v1/webhooks/wechat-refund`, {
          outRefundNo,
        });
        respond(res, 200, result);
        return;
      }

      respond(res, 404, { error: 'not found' });
    } catch (error) {
      respond(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleMini(
    action: string,
    body: unknown,
    res: ServerResponse,
    oa: FakeOaServer,
  ): Promise<void> {
    if (action === 'login-code') {
      const { openid, unionid } = body as { openid?: unknown; unionid?: unknown };
      if (typeof openid !== 'string' || openid === '') {
        respond(res, 400, { error: 'openid is required' });
        return;
      }
      const code = mintCode('login');
      oa.setMiniCode(code, typeof unionid === 'string' ? { openid, unionid } : { openid });
      respond(res, 200, { code });
      return;
    }
    if (action === 'phone-code') {
      const { phone } = body as { phone?: unknown };
      if (typeof phone !== 'string' || !/^1\d{10}$/.test(phone)) {
        respond(res, 400, { error: 'phone must be an 11-digit mainland number' });
        return;
      }
      const code = mintCode('phone');
      oa.setPhoneCode(code, { phone });
      respond(res, 200, { code });
      return;
    }
    if (action === 'request-payment') {
      const { package: pkg } = body as { package?: unknown };
      if (typeof pkg !== 'string' || !pkg.startsWith('prepay_id=')) {
        respond(res, 400, { error: 'a prepay_id package is required' });
        return;
      }
      // wx.requestPayment only ever pays a transaction the server placed;
      // an unknown prepay_id is a bug in the page, not a payment.
      const transaction = gateway.transactionForPrepay(pkg);
      if (!transaction) {
        respond(res, 409, { error: `no transaction for ${pkg} on the fake gateway` });
        return;
      }
      respond(res, 200, await settle(transaction.outTradeNo));
      return;
    }
    if (action === 'confirm-receipt') {
      const target = body as {
        transactionId?: unknown;
        merchantId?: unknown;
        merchantTradeNo?: unknown;
      };
      const key =
        typeof target.transactionId === 'string'
          ? `tx:${target.transactionId}`
          : `mch:${String(target.merchantId ?? '')}:${String(target.merchantTradeNo ?? '')}`;
      const order = oa.tradeOrders.get(key);
      if (!order) {
        respond(res, 409, { error: `WeChat knows no payment ${key}` });
        return;
      }
      order.orderState = 3;
      respond(res, 200, { orderState: order.orderState });
      return;
    }
    respond(res, 404, { error: `unknown mini action ${action}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port!;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The client side, used by specs. Plain `fetch` would do, but a named helper
 * keeps every spec's call to a one-liner and gives errors a place to become
 * readable instead of a bare non-2xx body.
 */
export async function completePayment(controlUrl: string, outTradeNo: string): Promise<void> {
  await post(controlUrl, '/complete-payment', { outTradeNo });
}

export async function completeRefund(controlUrl: string, outRefundNo: string): Promise<void> {
  await post(controlUrl, '/complete-refund', { outRefundNo });
}

async function post(controlUrl: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`gateway control ${path} failed: ${response.status} ${text}`);
  }
  return text.length > 0 ? JSON.parse(text) : undefined;
}
