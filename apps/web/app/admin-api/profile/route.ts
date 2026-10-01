import {
  systemProfileGet,
  systemProfileUpdate,
} from '@shop/contracts/system/system.admin.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../src/server';

/**
 * `/admin-api/profile` — my own account.
 *
 * Guarded by `auth:profile:read`, which every authenticated admin holds
 * implicitly, so an account with no grants at all can still see who it is.
 */
export const GET = handle(systemProfileGet, (ctx) => system.profileGet(ctx));

export const PUT = handle(systemProfileUpdate, async (ctx, { body }) => {
  const profile = await system.profileUpdate(ctx, body);
  ctx.audit(`admin:${profile.id}`);
  return profile;
});

export const dynamic = 'force-dynamic';
