import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RouteId } from '@shop/api-client';
import { useApiClient, useInvalidateRoutes } from '@shop/api-client/react';
import { DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { navigate } from '@/platform';
import { errorMessage as messageOf } from '@/lib/error-message';
import { confirm, toast } from '@/ui/feedback';

export type RefundActionKey = 'cancel' | 'hide' | 'returnShipment';

/**
 * Reads a change to a request makes stale: the list, the request, the order it is on. The
 * decorated pages' 售后 badge changes too: mark `DECOR_PAGE_READS` stale beside it.
 */
export const REFUND_READS: readonly RouteId[] = [
  'refund.myList',
  'refund.myDetail',
  'refund.applicableItems',
  'order.detail',
  'order.list',
  'order.counts',
];

/** 撤销申请, 删除记录 and 填写退货物流, the same on the list and the detail. */
export function useRefundActions(options: { onHidden?: () => void } = {}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRoutes();
  const [busy, setBusy] = useState<{ id: string; key: RefundActionKey } | null>(null);
  const inFlight = useRef(false);
  const onHidden = useRef(options.onHidden);
  useEffect(() => {
    onHidden.current = options.onHidden;
  });

  const run = useCallback(
    (key: RefundActionKey, id: string) => {
      if (key === 'returnShipment') {
        void navigate({ route: 'refundReturnShipment', params: { id } });
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy({ id, key });
      const work = async () => {
        if (key === 'cancel') {
          const ok = await confirm({
            content: '撤销后本次售后结束，确定撤销吗？',
            confirmText: '撤销申请',
            cancelText: '再想想',
            danger: true,
          });
          if (!ok) return;
          try {
            await client.call('refund.cancel', { params: { id } });
            toast.success('已撤销申请');
          } catch (error) {
            toast.text(messageOf(error, '撤销失败，请稍后重试'));
          }
          markStale(queryClient, ...DECOR_PAGE_READS);
          await invalidate(...REFUND_READS);
          return;
        }
        const ok = await confirm({
          content: '删除后记录不再显示，确定删除吗？',
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await client.call('refund.hide', { params: { id } });
          toast.success('记录已删除');
          await invalidate('refund.myList');
          onHidden.current?.();
        } catch (error) {
          toast.text(messageOf(error, '删除失败，请稍后重试'));
        }
      };
      void work().finally(() => {
        inFlight.current = false;
        setBusy(null);
      });
    },
    [client, queryClient, invalidate],
  );

  return { busy, run };
}
