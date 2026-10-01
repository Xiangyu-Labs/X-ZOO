import { authLogout } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';
import { bearerToken } from '../../_request';

/**
 * `DELETE /api/v1/auth/sessions/current` — this device only.
 *
 * The token is revoked by value: the session row is keyed by its hash, and the
 * caller's other devices must keep working. Idempotent, so a retry after a
 * dropped response is still a 200.
 */
export const DELETE = handle(authLogout, async (ctx) => {
  const token = bearerToken(ctx.request);
  if (token) await user.logout(ctx, token);
  return { ok: true as const };
});

export const dynamic = 'force-dynamic';
