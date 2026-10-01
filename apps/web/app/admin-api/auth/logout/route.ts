import { adminLogout } from '@shop/contracts/auth/auth.contract';
import { ADMIN_COOKIE, getContainer, handle, readCookie } from '../../../../src/server';

/**
 * Destroys the Redis session and clears the cookie. Idempotent: logging out
 * twice, or with a token that has already expired, is still a 200.
 */
export const POST = handle(adminLogout, async (ctx) => {
  const token = readCookie(ctx.request, ADMIN_COOKIE);
  if (token) await getContainer().adminAuth.logout(token);
  ctx.clearCookie(ADMIN_COOKIE);
  ctx.audit(`admin:${ctx.actor.id ?? '?'}`);
  return { ok: true as const };
});

export const dynamic = 'force-dynamic';
