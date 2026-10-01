import { useRouteQuery } from '@shop/api-client/react';
import { ACTIVITY_STALE_TIME, activityListInput } from './secondary-reads';

export interface ProductActivity {
  kind: 'groupbuy' | 'presale';
  activityId: string;
  price: string;
  /** 「2 人团」, 「付款后 7 天内发货」. */
  note: string;
}

const LONG = { staleTime: ACTIVITY_STALE_TIME } as const;

/**
 * The 拼团 / 预售 activities a product is in, for the entry bars on 商品详情.
 *
 * Each list is asked for this product's live activities (`productId`, H4) and one card is
 * enough: the page shows at most one bar per kind. A card the shopper cannot buy (sold out,
 * not started) shows no bar.
 */
export function useProductActivities(productId: string): ProductActivity[] {
  const input = activityListInput(productId);
  const groupbuys = useRouteQuery('groupbuy.list', input, LONG);
  const presales = useRouteQuery('presale.list', input, LONG);
  const out: ProductActivity[] = [];
  for (const card of groupbuys.data?.items ?? []) {
    if (card.productId !== productId || !card.canBuy) continue;
    out.push({
      kind: 'groupbuy',
      activityId: card.activityId,
      price: card.price,
      note: `${card.seatsRequired} 人团`,
    });
  }
  for (const card of presales.data?.items ?? []) {
    if (card.productId !== productId || !card.canBuy) continue;
    out.push({
      kind: 'presale',
      activityId: card.activityId,
      price: card.price,
      note: card.shipAfterDays > 0 ? `付款后 ${card.shipAfterDays} 天内发货` : '付款后尽快发货',
    });
  }
  return out;
}
