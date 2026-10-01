import { create } from 'zustand';
import type { SubscribeScene } from '@/platform';

/** What is being bought: the cart's ticked rows (or a subset), or one SKU via 立即购买. */
export type CheckoutItems =
  | { source: 'cart'; cartItemIds: string[] }
  | { source: 'buy-now'; item: { skuId: string; quantity: number } };

/**
 * The order kind (`checkoutKind`, ORDER-009): a plain order, a group buy (开团 without
 * `groupId`, 参团 with it) or a presale deposit. Typed here the way the contract types it.
 */
export type CheckoutKind =
  | { kind: 'normal' }
  | { kind: 'groupbuy'; kindMeta: { activityId: string; groupId?: string } }
  | { kind: 'presale'; kindMeta: { activityId: string } };

/**
 * What 立即购买, the cart and the activity pages hand the checkout page. In memory, never in
 * the URL: the checkout page is not linkable (docs/mini/pages.md §2.3).
 */
export type CheckoutDraft = CheckoutItems &
  CheckoutKind & {
    /** Product names by SKU id, so a refusal can name the item (「…」每人限购 2 件). */
    names?: Readonly<Record<string, string>> | undefined;
  };

/** The subscribe scene (C08) for 提交订单 of this kind. */
export function subscribeSceneOf(draft: CheckoutKind): SubscribeScene {
  if (draft.kind === 'groupbuy') return 'groupbuyCheckout';
  if (draft.kind === 'presale') return 'presaleCheckout';
  return 'checkout';
}

/**
 * The `order.checkoutPreview` / `order.create` body for a draft, with the shopper's choices on
 * it: `addressId` (omitted → the default address) and `userCouponId` (`null` → no coupon, omitted
 * → none picked yet).
 */
export function checkoutBody(
  draft: CheckoutDraft,
  choices: { addressId?: string | undefined; userCouponId?: string | null | undefined } = {},
) {
  const items =
    draft.source === 'cart'
      ? { source: 'cart' as const, cartItemIds: draft.cartItemIds }
      : { source: 'buy-now' as const, item: draft.item };
  const kind =
    draft.kind === 'normal'
      ? { kind: 'normal' as const }
      : draft.kind === 'groupbuy'
        ? { kind: 'groupbuy' as const, kindMeta: draft.kindMeta }
        : { kind: 'presale' as const, kindMeta: draft.kindMeta };
  return {
    ...items,
    ...kind,
    ...(choices.addressId ? { addressId: choices.addressId } : {}),
    ...(choices.userCouponId !== undefined ? { userCouponId: choices.userCouponId } : {}),
  };
}

export const useCheckoutDraft = create<{
  draft: CheckoutDraft | null;
  setDraft: (draft: CheckoutDraft | null) => void;
}>()((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
}));

/** Client-generated, unique per submit attempt (`checkoutCreateBody.idempotencyKey`). */
export function newIdempotencyKey(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `mini-${Date.now().toString(36)}-${random}`;
}
