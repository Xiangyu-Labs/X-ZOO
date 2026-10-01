import { couponAdminCreate, couponAdminList } from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../src/server';

/**
 * `/admin-api/coupons` — the campaign list and the create form.
 *
 * The directory mirrors the URL because App Router derives one from the other,
 * so an admin route lives under `app/admin-api/<resource>/`, not under a
 * folder named after the domain.
 *
 * A route file does three things and no more: name the contract, call one
 * service function, and (for a write) say what was acted on for the audit log.
 * No validation — `handle()` has already parsed `query`, `params` and `body`
 * against the contract; no try/catch — a `DomainError` is already the right
 * status and message; no mapping — the service returns the wire shape.
 */
export const GET = handle(couponAdminList, (ctx, { query }) => coupon.adminList(ctx, query));

export const POST = handle(couponAdminCreate, async (ctx, { body }) => {
  const created = await coupon.adminCreate(ctx, body);
  ctx.audit(`coupon:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
