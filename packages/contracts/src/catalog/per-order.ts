/**
 * 每单限购 at its ceiling means 不限. The activity column is NOT NULL, so 不限 is stored as this
 * number; screens show nothing for it (no 每单限 999 件) and the product editor shows it empty.
 * No zod here: the mini-program imports this file.
 */
export const PER_ORDER_UNLIMITED = 999;

/** Whether a stored 每单限购 is really a limit a shopper should be told about. */
export function hasPerOrderLimit(
  perOrderQuantity: number | null | undefined,
): perOrderQuantity is number {
  return typeof perOrderQuantity === 'number' && perOrderQuantity < PER_ORDER_UNLIMITED;
}
