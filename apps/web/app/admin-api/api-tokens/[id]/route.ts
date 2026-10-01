import { authApiTokenRevoke } from '@shop/contracts/auth/auth.api-token.contract';
import { revokeToken } from '@shop/core/auth';
import { handle } from '../../../../src/server';

/** `/admin-api/api-tokens/:id` — revoking disconnects that agent on its next request. */
export const DELETE = handle(authApiTokenRevoke, async (ctx, { params }) => {
  await revokeToken(ctx, params);
  ctx.audit(`api-token:${params.id}`);
});

export const dynamic = 'force-dynamic';
