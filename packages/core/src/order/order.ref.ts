import { ORDER_NO_LENGTH } from '@shop/contracts/order/order.ref.schemas';
import type { DbOrTx } from '@shop/db';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId } from '../kernel/ids';
import * as refRepo from './order.ref.repo';

/**
 * Resolving the `:id` of a storefront order route.
 *
 * Every storefront route that names an order takes **either** the surrogate id
 * **or** the 24-digit order number, and every one of them resolves it here so
 * there is exactly one place that knows the rule and exactly one place that
 * decides who may see the order.
 *
 * ## Why the two can never collide
 *
 * `generateOrderNo` emits exactly `ORDER_NO_LENGTH` (24) digits. `orders.id` is
 * a `bigint` identity column, so the largest id that can ever exist has 19
 * digits, and `fromId` refuses anything past `Number.MAX_SAFE_INTEGER` (16
 * digits) besides. A reference of exactly 24 digits is therefore an order
 * number and a shorter one is an id, with no overlap to disambiguate and no
 * "try one, then the other" fallback that could be timed.
 *
 * ## Why the owner is in the WHERE
 *
 * A stranger's order number and an order number that was never issued give the
 * same answer: `null`, which every caller turns into its own 404. Resolving
 * first and authorising afterwards would leak the existence of other people's
 * orders to anyone who can guess a timestamp (AUTH-005).
 */

export { ORDER_NO_LENGTH };

export const isOrderNo = (ref: string): boolean => ref.length === ORDER_NO_LENGTH;

/**
 * `ref` -> `orders.id`, scoped to `userId`. `null` when there is no such order
 * **or** it belongs to somebody else — callers must not tell the two apart.
 *
 * An id reference is returned as-is without a lookup: every caller looks the
 * row up next anyway, under its own visibility rule, so a probe here would only
 * be a second round trip and a second answer to keep consistent.
 */
export async function resolveOrderRef(
  db: DbOrTx,
  args: { ref: string; userId: number },
): Promise<number | null> {
  if (!isOrderNo(args.ref)) return fromId(args.ref);
  return refRepo.findIdByOrderNoForUser(db, { orderNo: args.ref, userId: args.userId });
}

/**
 * The shape route-facing services want: the caller is the current user, and a
 * reference that resolves to nothing is the domain's own "not found".
 *
 * `notFound` is the error code of the *calling* domain — `ORDER_NOT_FOUND`,
 * `PAYMENT_ORDER_NOT_FOUND`, `REFUND_ORDER_NOT_FOUND` — because a shopper
 * following a stale link should read the message of the screen they are on.
 */
export async function requireOrderRef(
  ctx: Ctx,
  ref: string,
  notFound = 'ORDER_NOT_FOUND',
): Promise<{ orderId: number; userId: number }> {
  const userId = requireUserId(ctx);
  const orderId = await resolveOrderRef(ctx.db, { ref, userId });
  if (orderId === null) throw new DomainError(notFound);
  return { orderId, userId };
}
