import { useRef } from 'react';
import { useDidShow } from '@tarojs/taro';
import { useRouteQuery } from '@shop/api-client/react';
import { ACTIVITY_STALE_TIME, activityListInput } from './secondary-reads';

export interface ProductActivity {
  kind: 'groupbuy' | 'presale';
  activityId: string;
  price: string;
  endAt: string;
  canBuy: boolean;
  seatsRequired?: number;
  /** 「2 人团」, 「付款后 7 天内发货」. */
  note: string;
}

const LONG = { staleTime: ACTIVITY_STALE_TIME };

/**
 * The 拼团 / 预售 activities a product is in, for the entry bars on 商品详情.
 *
 * Each list is asked for this product's live activities (`productId`, H4) and one card is
 * enough: the page shows at most one bar per kind. Sold-out activities stay visible
 * in the price banner, with their purchase button disabled.
 */
export function useProductActivities(productId: string, enabled = true): ProductActivity[] {
  const input = activityListInput(productId);
  const groupbuys = useRouteQuery('groupbuy.list', input, { ...LONG, enabled });
  const presales = useRouteQuery('presale.list', input, { ...LONG, enabled });
  const shown = useRef(false);
  useDidShow(() => {
    if (!enabled) return;
    if (!shown.current) {
      shown.current = true;
      return;
    }
    void groupbuys.refetch();
    void presales.refetch();
  });
  const out: ProductActivity[] = [];
  for (const card of groupbuys.data?.items ?? []) {
    if (card.productId !== productId) continue;
    out.push({
      kind: 'groupbuy',
      activityId: card.activityId,
      price: card.price,
      endAt: card.endAt,
      canBuy: card.canBuy,
      seatsRequired: card.seatsRequired,
      note: `${card.seatsRequired} 人团`,
    });
  }
  for (const card of presales.data?.items ?? []) {
    if (card.productId !== productId) continue;
    out.push({
      kind: 'presale',
      activityId: card.activityId,
      price: card.price,
      endAt: card.endAt,
      canBuy: card.canBuy,
      note: card.shipAfterDays > 0 ? `付款后 ${card.shipAfterDays} 天内发货` : '付款后尽快发货',
    });
  }
  return out;
}
