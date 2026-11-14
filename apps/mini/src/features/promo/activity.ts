import type { ProductCardData } from '@/ui/product-card';

/**
 * A 拼团 / 预售 activity's phase for the shopper, from its window and stock. `canBuy` is the
 * server's decision and wins: this only picks the words for why it said no.
 */
export type ActivityPhase = 'upcoming' | 'on' | 'sold-out' | 'ended' | 'unavailable';

export interface ActivityWindow {
  startAt: string;
  endAt: string;
  stock: number;
  canBuy: boolean;
}

export function activityPhase(activity: ActivityWindow, nowMs: number): ActivityPhase {
  if (nowMs < Date.parse(activity.startAt)) return 'upcoming';
  if (nowMs >= Date.parse(activity.endAt)) return 'ended';
  if (activity.stock <= 0) return 'sold-out';
  return activity.canBuy ? 'on' : 'unavailable';
}

/** 预售: when it ships (`shipAfterDays` is counted from payment). */
export function shipText(shipAfterDays: number): string {
  return shipAfterDays > 0 ? `付款后 ${shipAfterDays} 天内发货` : '付款后尽快发货';
}

/**
 * A 拼团 / 预售 card as the kit's `ProductCard` takes it: the activity price, with the list price
 * struck through when there is one.
 */
export function activityCard(card: {
  activityId: string;
  title: string;
  intro: string | null;
  imageUrl: string | null;
  price: string;
  originalPrice: string | null;
  stock: number;
  sales: number;
}): { product: ProductCardData; activityPrice: string | undefined } {
  const product: ProductCardData = {
    id: card.activityId,
    name: card.title,
    subtitle: card.intro,
    imageUrl: card.imageUrl ?? '',
    cardImageUrl: null,
    price: card.originalPrice ?? card.price,
    originalPrice: null,
    stock: card.stock,
    salesDisplay: card.sales,
    labels: [],
    canAddToCart: false,
  };
  return { product, activityPrice: card.originalPrice ? card.price : undefined };
}
