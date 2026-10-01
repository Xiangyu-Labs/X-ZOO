import { resolveStockPort } from './catalog.port';
import * as repo from './order.repo';
import { onOrderPaid } from './ports';

/** The hook's name, as `onOrderPaid.names()` and the hook-failure log show it. */
export const COMMIT_SALE_HOOK = 'order:commit-sale';

/**
 * The money arrived, so the reservation becomes a sale.
 *
 * `StockPort.commit` is the only thing that moves `product_skus.sales` (and,
 * through its roll-up, `products.sales`) up. Checkout reserved the stock, the
 * cancel path hands it back uncommitted, and the refund path hands it back with
 * `committed: true` — which only balances if this ran at payment. Without this
 * hook 已售 would never rise, and a refund would lower a number the payment had
 * never raised.
 *
 * It runs for **every** paid order, whatever its kind. Group buy and presale
 * keep their own campaign ledgers (`groupbuy:take-seat`, `presale:commit-sale`)
 * and never touch the SKU's `sales`, so there is exactly one writer of the
 * SKU-level sale and no kind can count it twice. When a campaign then refuses
 * the sale (a lost seat, a filled quota), the order stays paid and its
 * auto-refund puts the units back through the refund path's committed release,
 * which is the mirror of this.
 *
 * Idempotent by the port's own ledger key (`catalog.stock.commit`, per order):
 * a second dispatch for the same order is a no-op, so a replayed notification
 * that somehow reached the hooks could not add the units twice.
 *
 * The lines are read from the order, not from the event, because they are what
 * checkout reserved: the same `stockLinesOf` the cancel path releases.
 */
export function installStockCommitHook(): void {
  onOrderPaid.register(COMMIT_SALE_HOOK, async (tx, _ctx, event) => {
    const lines = await repo.stockLinesOf(tx, event.orderId);
    if (lines.length === 0) return;
    await resolveStockPort().commit(tx, event.orderId, lines);
  });
}

// On import as well as from `registerOrderDomain()`: `order/index.ts` imports
// this file before `order.fulfil.effects.ts`, which installs its own paid hook
// on import, so in a production module graph the sale is committed by the
// first hook `onOrderPaid` runs — ahead of `order:auto-deliver` and of the
// campaign hooks (`groupbuy:take-seat`, `presale:commit-sale`) that assume it.
installStockCommitHook();
