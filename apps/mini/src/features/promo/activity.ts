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

/** The real deadline a countdown may show (C16): the start or the end of the window. */
export function activityDeadline(
  activity: Pick<ActivityWindow, 'startAt' | 'endAt'>,
  phase: ActivityPhase,
): { label: string; at: string } | null {
  if (phase === 'upcoming') return { label: '距开始', at: activity.startAt };
  if (phase === 'on') return { label: '距结束', at: activity.endAt };
  return null;
}

/** The disabled button's words. */
export const PHASE_BUTTON: Record<Exclude<ActivityPhase, 'on'>, string> = {
  upcoming: '即将开始',
  'sold-out': '已售罄',
  ended: '活动已结束',
  unavailable: '暂不可购买',
};

/** 预售: when it ships (`shipAfterDays` is counted from payment). */
export function shipText(shipAfterDays: number): string {
  return shipAfterDays > 0 ? `付款后 ${shipAfterDays} 天内发货` : '付款后尽快发货';
}

/** 「已拼 12 件」 / 「已售 12 件」: nothing below one (C16: no made-up popularity). */
export function salesText(verb: '已拼' | '已售', sales: number): string {
  return sales > 0 ? `${verb} ${sales} 件` : '';
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

/** 拼团有效期 in words: 「24 小时」「2 天」「30 分钟」. */
export function ttlText(seconds: number): string {
  const day = 24 * 3600;
  if (seconds >= day && seconds % day === 0) return `${seconds / day} 天`;
  if (seconds >= 3600) {
    const hours = Math.round((seconds / 3600) * 10) / 10;
    return `${hours} 小时`;
  }
  return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
}
