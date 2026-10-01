import { DomainError } from './errors';

/**
 * What an edit form may do to a stock counter that orders move underneath it.
 *
 * The form sends the number it wants (`sent`) and, optionally, the number it
 * was showing when it loaded (`expected`). The row is read **locked**, so
 * `current` is the truth for the rest of the transaction.
 *
 * - no `expected`, or a row that does not exist yet: the form's number, as sent;
 * - `sent === expected`: the operator did not touch it — keep `current`, since
 *   writing the stale number back would hand out again what orders took;
 * - `current === expected`: nobody moved it — write `sent`;
 * - otherwise: a conflict. The caller refuses with a 409 and the operator
 *   re-enters the number over what is actually there.
 */
export type StockEdit = { kind: 'write'; value: number } | { kind: 'conflict'; current: number };

export function resolveStockEdit(args: {
  sent: number;
  expected: number | undefined;
  current: number | undefined;
}): StockEdit {
  const { sent, expected, current } = args;
  if (current === undefined || expected === undefined) return { kind: 'write', value: sent };
  if (sent === expected) return { kind: 'write', value: current };
  if (current === expected) return { kind: 'write', value: sent };
  return { kind: 'conflict', current };
}

/**
 * An activity edit's stocks — the activity's own and each SKU's — resolved
 * against the locked rows. Throws `conflictCode` (with `{ skuId?, expected,
 * current }`) on the first counter the operator and an order both moved.
 */
export function resolveActivityStocks(
  locked: { stock: number; skus: ReadonlyMap<number, number> },
  form: {
    stock: number;
    expectedStock?: number | undefined;
    skus: readonly { skuId: number; stock: number; expectedStock?: number | undefined }[];
  },
  conflictCode: string,
): { stock: number; skuStocks: Map<number, number> } {
  const settle = (
    edit: { sent: number; expected: number | undefined; current: number | undefined },
    skuId?: number,
  ): number => {
    const resolved = resolveStockEdit(edit);
    if (resolved.kind === 'write') return resolved.value;
    throw new DomainError(conflictCode, {
      details: {
        ...(skuId === undefined ? {} : { skuId }),
        expected: edit.expected,
        current: resolved.current,
      },
    });
  };
  const stock = settle({ sent: form.stock, expected: form.expectedStock, current: locked.stock });
  const skuStocks = new Map<number, number>();
  for (const sku of form.skus) {
    skuStocks.set(
      sku.skuId,
      settle(
        { sent: sku.stock, expected: sku.expectedStock, current: locked.skus.get(sku.skuId) },
        sku.skuId,
      ),
    );
  }
  return { stock, skuStocks };
}
