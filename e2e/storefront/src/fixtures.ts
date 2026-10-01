import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test';

import { completePayment } from './gateway-control';
import { BASE_URL } from './stack-file';
import { stack, closeStack, type Stack } from './stack';

/**
 * The base `test`: the stack, the page-health listeners and an admin session
 * for the steps (ship, refund-approve, arranging data) no storefront screen
 * performs. `src/mini.ts` extends it with the shopper's phone.
 */

export interface Fixtures {
  /** The super admin, cookie-authenticated against `/admin-api`. */
  adminApi: APIRequestContext;
  /**
   * Every `console.error`/`pageerror` the test's own `page` has seen, in
   * order, from before its first navigation.
   * The browser's own "Failed to load resource" echo is left out: the
   * request it echoes is in `failedRequests`, with the URL the console
   * message does not carry.
   */
  consoleErrors: string[];
  /**
   * Every request `page` made that failed — `METHOD /path STATUS`, or
   * `METHOD /path FAILED <reason>` for a transport error. The journeys'
   * "no console error, no failed request" assertions and the per-test logs
   * CI keeps (`console-errors.txt`, `failed-requests.txt`) read these two
   * arrays.
   */
  failedRequests: string[];
}

// A 1x1 PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/**
 * Keeps a browser context offline: a run must never reach the internet, and
 * must not fail because a picture points somewhere it cannot reach. Anything
 * not addressed to
 * the stack's own origin is answered locally — an image with a pixel,
 * anything else with an empty 204.
 */
export async function keepOffline(context: BrowserContext): Promise<void> {
  const local = new URL(BASE_URL).host;
  await context.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== local,
    (route) =>
      route.request().resourceType() === 'image'
        ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
        : route.fulfill({ status: 204, body: '' }),
  );
}

export interface WorkerFixtures {
  shop: Stack;
}

async function loginCookies(
  request: APIRequestContext,
  account: string,
  password: string,
): Promise<void> {
  const response = await request.post('/admin-api/auth/login', { data: { account, password } });
  expect(response.ok(), `admin login failed: ${response.status()} ${await response.text()}`).toBe(
    true,
  );
}

export const test = base.extend<Fixtures & { localOnly: undefined }, WorkerFixtures>({
  // Not `offline`: that name is Playwright's own context option.
  localOnly: [
    async ({ context }, use) => {
      await keepOffline(context);
      await use(undefined);
    },
    { auto: true },
  ],

  shop: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(await stack());
      await closeStack();
    },
    { scope: 'worker' },
  ],

  consoleErrors: async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    // An unhandled rejection reaches Playwright as a `pageerror` with an
    // empty message whenever the app rejects with a plain object. Reported here
    // instead, once, with the reason spelled out; `preventDefault` stops the
    // browser reporting the same rejection a second time, empty.
    await page.addInitScript(() => {
      window.addEventListener('unhandledrejection', (event) => {
        const reason: unknown = event.reason;
        let text: string;
        if (reason instanceof Error) text = `${reason.name}: ${reason.message}`;
        else {
          try {
            text = JSON.stringify(reason) ?? String(reason);
          } catch {
            text = String(reason);
          }
        }
        event.preventDefault();
        console.error(`unhandledrejection ${text}`);
      });
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (message.text().startsWith('Failed to load resource:')) return;
      // `console.error(someObject)` reaches Playwright as the text "Object";
      // the recorded line is upgraded to the serialised arguments once they
      // resolve, so the log says *what* the app complained about.
      const index = errors.push(message.text()) - 1;
      void Promise.all(
        message.args().map((arg) =>
          arg.jsonValue().then(
            (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)),
            () => arg.toString(),
          ),
        ),
      ).then((parts) => {
        if (parts.length > 0) errors[index] = parts.join(' ');
      });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await use(errors);
    await testInfo.attach('console-errors.txt', {
      body: errors.join('\n') || '(none)',
      contentType: 'text/plain',
    });
  },

  failedRequests: async ({ page }, use, testInfo) => {
    const failed: string[] = [];
    const describe = (method: string, url: string): string => {
      const parsed = new URL(url);
      return parsed.origin === new URL(BASE_URL).origin
        ? `${method} ${parsed.pathname}`
        : `${method} ${url}`;
    };
    page.on('response', (response) => {
      if (response.status() >= 400)
        failed.push(
          `${describe(response.request().method(), response.url())} ${response.status()}`,
        );
    });
    page.on('requestfailed', (request) => {
      // A navigation away from the app aborts whatever the page was still
      // loading; that is the test moving on, not the page failing.
      if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
      failed.push(
        `${describe(request.method(), request.url())} FAILED ${request.failure()?.errorText}`,
      );
    });
    await use(failed);
    await testInfo.attach('failed-requests.txt', {
      body: failed.join('\n') || '(none)',
      contentType: 'text/plain',
    });
  },

  adminApi: async ({ playwright, shop }, use) => {
    const request = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { origin: BASE_URL },
    });
    await loginCookies(request, shop.admin.account, shop.admin.password);
    await use(request);
    await request.dispose();
  },
});

export { expect };

/**
 * Drives the fake gateway's async notification, the same call a real WeChat
 * Pay completion would make against `/api/v1/webhooks/wechat-pay` — see
 * `src/gateway-control.ts` for why this cannot be `shop`'s in-process
 * `FakeWechatGateway` object directly (it lives in `scripts/serve.ts`'s
 * process, not this one).
 */
export async function payOrder(shop: Stack, outTradeNo: string): Promise<void> {
  await completePayment(shop.gatewayControlUrl, outTradeNo);
}

/**
 * Polls until `assertion` stops throwing, for the handful of places a spec
 * has to wait on the real worker (started by `scripts/serve.ts`) to finish
 * processing a queued effect — there is no UI signal for "the job ran".
 */
export async function waitFor(assertion: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
