import { useCheckoutDraft, type CheckoutDraft } from '@/features/checkout/draft';
import { navigate } from '@/platform';

/**
 * One activity purchase: 开团 (a group buy without `groupId`), 参团 (with it) or a 预售 order.
 * There is no join endpoint: every one of them is a checkout order with `kind` / `kindMeta`
 * (`groupbuy.storefront.contract`).
 */
export type ActivityPurchase =
  | {
      kind: 'groupbuy';
      activityId: string;
      groupId?: string | undefined;
      skuId: string;
      quantity: number;
    }
  | { kind: 'presale'; activityId: string; skuId: string; quantity: number };

/** The checkout draft for a purchase: a buy-now item plus the order kind. */
export function activityCheckoutDraft(purchase: ActivityPurchase): CheckoutDraft {
  const item = { skuId: purchase.skuId, quantity: purchase.quantity };
  if (purchase.kind === 'presale') {
    return {
      source: 'buy-now' as const,
      item,
      kind: 'presale' as const,
      kindMeta: { activityId: purchase.activityId },
    };
  }
  return {
    source: 'buy-now' as const,
    item,
    kind: 'groupbuy' as const,
    kindMeta: {
      activityId: purchase.activityId,
      ...(purchase.groupId ? { groupId: purchase.groupId } : {}),
    },
  };
}

/** Hands the purchase to 确认订单 (in memory, never in the URL) and opens it. */
export async function startActivityCheckout(purchase: ActivityPurchase): Promise<void> {
  useCheckoutDraft.getState().setDraft(activityCheckoutDraft(purchase));
  await navigate({ route: 'checkout', params: {} });
}
