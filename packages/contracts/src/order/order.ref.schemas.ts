import { z } from 'zod';

/**
 * An **order reference**: the `:id` of every storefront route that names an
 * order.
 *
 * The storefront carries one identifier per order and uses it for two things at
 * once — it prints it (订单号) and it routes on it. Only the surrogate id was
 * routable, so either the buyer saw a number that appears nowhere else (not on
 * the WeChat payment record, not in the 客服 conversation), or every deep link
 * a support agent pasted 404'd. Both halves work once `:id` accepts either.
 *
 * **The two can never collide.** `generateOrderNo` emits exactly
 * {@link ORDER_NO_LENGTH} digits (`yyyyMMddHHmmss` + a 3-digit counter + 7
 * random digits) and `orders.id` is a `bigint` identity column, whose largest
 * value has 19 digits. A reference of exactly 24 digits is therefore an order
 * number and nothing else, and a shorter one is an id and nothing else. The
 * assertion lives in `packages/core/src/order/order.ref.test.ts`.
 */
export const ORDER_NO_LENGTH = 24;

/** The widest a `bigint` primary key can be, in digits (`9223372036854775807`). */
export const MAX_ID_DIGITS = 19;

export const orderRef = z
  .string()
  .regex(new RegExp(`^[1-9]\\d{0,${ORDER_NO_LENGTH - 1}}$`), '订单号格式不正确');
export type OrderRef = z.infer<typeof orderRef>;

/** `{ id }` for `/api/v1/orders/:id` and its sub-resources. */
export const orderRefParams = z.object({ id: orderRef });
export type OrderRefParams = z.infer<typeof orderRefParams>;
