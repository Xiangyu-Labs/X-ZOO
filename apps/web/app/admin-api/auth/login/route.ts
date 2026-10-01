import { adminLogin } from '@shop/contracts/auth/auth.contract';
import { ADMIN_COOKIE, adminCookieMaxAge, getContainer, handle } from '../../../../src/server';
import { requestMeta } from '../../../api/v1/auth/_request';

/**
 * Sets the `admin_session` cookie and returns the profile the shell needs.
 *
 * The token never appears in the body: a JS-readable token would undo the
 * point of an httpOnly cookie. `handle()` marks the cookie httpOnly +
 * SameSite=Lax, and Secure whenever `NODE_ENV=production`.
 *
 * 「记住登录状态」 makes it a seven-day cookie that slides on every request
 * (`handle()` re-issues it); without it the cookie ends with the browser and
 * the server session after eight idle hours.
 *
 * The route is public, so `handle()` audits nothing here; the service writes
 * every outcome itself under `auth.adminLogin`, with the address
 * from `clientIp()` and the user agent — never the body.
 */
export const POST = handle(adminLogin, async (ctx, { body }) => {
  const container = getContainer();
  const result = await container.adminAuth.login(ctx, body, requestMeta(ctx.request));
  const maxAge = adminCookieMaxAge({ remember: result.remember, ttlMs: result.expiresInMs });
  ctx.setCookie(ADMIN_COOKIE, result.token, {
    ...(maxAge !== undefined ? { maxAge } : {}),
    path: '/',
  });
  return result.profile;
});

export const dynamic = 'force-dynamic';
