import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RouteId } from '@shop/api-client';
import { useApiClient, useInvalidateRoutes } from '@shop/api-client/react';
import { COUPON_READS, DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { confirmReceipt, navigate } from '@/platform';
import { errorMessage as messageOf } from '@/lib/error-message';
import { confirm, toast } from '@/ui/feedback';
import type { OrderActionKey } from '@/ui/order-actions';

/**
 * Reads an order change makes stale: the lists, the badges, the order itself. The decorated
 * pages' 订单入口 badges and coupon states change too: mark `DECOR_PAGE_READS` stale beside it.
 */
export const ORDER_READS: readonly RouteId[] = [
  'order.list',
  'order.counts',
  'order.detail',
  'order.myShipments',
];

/**
 * A cancelled unpaid order puts its coupon back in the wallet (and back in the cart's hint and
 * 确认订单's list), and a cancelled 拼团 order gives its seat back (and the activity page its
 * 发起拼团, the stock its units).
 */
export const CANCEL_READS: readonly RouteId[] = [
  ...ORDER_READS,
  ...COUPON_READS,
  'groupbuy.detail',
  'groupbuy.groupDetail',
  'groupbuy.myGroups',
  'presale.detail',
];

export interface OrderRef {
  id: string;
}

export interface OrderActionsOptions {
  /** After 删除订单 went through (the detail page goes back). */
  onDeleted?: ((orderId: string) => void) | undefined;
}

export interface OrderActionsState {
  /** The action in flight, and whose. */
  busy: { orderId: string; key: OrderActionKey } | null;
  run: (key: OrderActionKey, order: OrderRef) => void;
}

/**
 * What a button of `orderActions(order)` does, the same on 我的订单 and 订单详情. Writes ask
 * first where they cannot be undone, spin their button while in flight, and refresh the
 * lists and the order when done.
 */
export function useOrderActions(options: OrderActionsOptions = {}): OrderActionsState {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRoutes();
  const [busy, setBusy] = useState<OrderActionsState['busy']>(null);
  const inFlight = useRef(false);
  const onDeleted = useRef(options.onDeleted);
  useEffect(() => {
    onDeleted.current = options.onDeleted;
  });

  const guarded = useCallback(
    async (orderId: string, key: OrderActionKey, work: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy({ orderId, key });
      try {
        await work();
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [],
  );

  const run = useCallback(
    (key: OrderActionKey, order: OrderRef) => {
      const orderId = order.id;
      switch (key) {
        case 'pay':
          void navigate({ route: 'cashier', params: { orderId } });
          return;
        case 'logistics':
          void navigate({ route: 'logistics', params: { orderId } });
          return;
        case 'review':
          void navigate({ route: 'reviewWrite', params: { orderId } });
          return;
        case 'aftersale':
          void navigate({ route: 'refundApply', params: { orderId } });
          return;
        case 'confirm':
          // The component and the dialog both need the tap: nothing is awaited before them.
          void guarded(orderId, key, async () => {
            const outcome = await confirmReceipt(client, orderId);
            if (outcome.kind === 'failed') toast.text(outcome.message);
            if (outcome.kind === 'confirmed') toast.success('已确认收货');
            // `returned`: back from WeChat's component without its answer; show what is true now.
            if (outcome.kind === 'confirmed' || outcome.kind === 'returned') {
              markStale(queryClient, ...DECOR_PAGE_READS);
              await invalidate(...ORDER_READS);
            }
          });
          return;
        case 'cancel':
          void guarded(orderId, key, async () => {
            const ok = await confirm({
              content: '确定取消这个订单吗？取消后需重新下单。',
              confirmText: '取消订单',
              cancelText: '再想想',
              danger: true,
            });
            if (!ok) return;
            try {
              await client.call('order.cancel', { params: { id: orderId }, body: {} });
              toast.success('订单已取消');
            } catch (error) {
              toast.text(messageOf(error, '取消失败，请稍后重试'));
            }
            markStale(queryClient, ...DECOR_PAGE_READS);
            await invalidate(...CANCEL_READS);
          });
          return;
        case 'delete':
          void guarded(orderId, key, async () => {
            const ok = await confirm({
              content: '删除后订单不再显示，确定删除吗？',
              confirmText: '删除',
              danger: true,
            });
            if (!ok) return;
            try {
              await client.call('order.hide', { params: { id: orderId } });
              toast.success('订单已删除');
              markStale(queryClient, ...DECOR_PAGE_READS);
              await invalidate('order.list', 'order.counts');
              onDeleted.current?.(orderId);
            } catch (error) {
              toast.text(messageOf(error, '删除失败，请稍后重试'));
            }
          });
          return;
        case 'rebuy':
          void guarded(orderId, key, async () => {
            try {
              const result = await client.call('cart.rebuy', { body: { orderId } });
              await invalidate('cart.list', 'cart.count');
              if (result.added === 0) {
                toast.text('商品已下架或库存不足，暂时无法再次购买');
                return;
              }
              if (result.skippedSkuIds.length > 0)
                toast.text('部分商品暂时无法购买，其余已加入购物车');
              await navigate({ route: 'cart', params: {} });
            } catch (error) {
              toast.text(messageOf(error, '加入购物车失败，请稍后重试'));
            }
          });
          return;
      }
    },
    [client, queryClient, guarded, invalidate],
  );

  return { busy, run };
}
