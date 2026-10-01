import { createApiClient } from '@shop/api-client';
import { serverClockTransport } from '@/lib/server-clock';
import { platform } from '@/platform';
import { renewingTransport } from '@/session/renewing-transport';

/**
 * Sent as `X-Client-Version`: the release version, fixed at build time (config/index.ts:
 * `TARO_APP_VERSION`, else apps/mini/package.json `version`). Bumped per release
 * (docs/mini/device-check.md §9).
 */
export const CLIENT_VERSION = process.env.TARO_APP_VERSION || '0.0.0';

interface AuthHooks {
  getToken: () => string | null;
  /**
   * After a request sent with `sent` met a 401: the token to send it again with (renewing the
   * session if needed), or `null` to let the 401 stand (session.ts `renewFor`).
   */
  renew: (sent: string) => Promise<string | null>;
  onUnauthorized: () => void;
}

let auth: AuthHooks = {
  getToken: () => null,
  renew: () => Promise.resolve(null),
  onUnauthorized: () => undefined,
};

/**
 * The session module (`src/session`) plugs its token, its renewal and its 401 handling in
 * here, so the client and the session do not import each other.
 */
export function installAuth(hooks: AuthHooks): void {
  auth = hooks;
}

/** The session's hooks, for requests that do not go through the client (`uploadImage`). */
export function authHooks(): Readonly<AuthHooks> {
  return auth;
}

/**
 * The one `/api/v1` client. Its transport, origin and `X-Client-Platform` come from the build's
 * platform implementation: `Taro.request` to the shop's origin as `wechat-mini` in the
 * mini-program, same-origin `fetch` on H5 (as `wechat-mini` in the e2e emulation build). The
 * transport renews an expired session and replays the request once (session/renewing-transport),
 * and sets the server clock from any `X-Server-Time` header (lib/server-clock).
 */
export const api = createApiClient({
  baseUrl: platform.api.baseUrl,
  transport: renewingTransport(serverClockTransport(platform.api.transport), {
    renew: (sent) => auth.renew(sent),
  }),
  platform: platform.api.clientPlatform,
  clientVersion: CLIENT_VERSION,
  getToken: () => auth.getToken(),
  onUnauthorized: () => auth.onUnauthorized(),
});
