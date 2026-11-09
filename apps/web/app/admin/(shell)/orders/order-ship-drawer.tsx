'use client';

import { orderAdminDetail } from '@shop/contracts/order/order.admin.contract';

import { useRouteQuery } from '@/admin/api';
import { DetailDrawer } from '@/admin/kit/detail-drawer';

import { ShipPanel } from './[id]/ship-panel';

/** Which half of the shipment panel the card action opened. */
export interface OrderShipTarget {
  orderId: string;
  mode: 'ship' | 'logistics';
}

/**
 * 发货 / 物流详情 without leaving the list.
 *
 * The drawer reads the same order detail the order page does and renders the
 * existing `ShipPanel`, so a shipment created here is the same POST, with the
 * same line bounds and the same permission. 物流详情 is the panel's read-only
 * mode: shipment rows and the courier feed, no 发货 button.
 */
export function OrderShipDrawer({
  target,
  onClose,
}: {
  target: OrderShipTarget | null;
  onClose: () => void;
}) {
  const order = useRouteQuery(
    orderAdminDetail,
    { params: { id: target?.orderId ?? '' } },
    {
      enabled: target !== null,
      presentError: false,
      // The card may have been on screen for a while; 发货 reads the current
      // quantities and the current shipment list, not the page's snapshot.
      staleTime: 0,
      refetchOnMount: 'always',
    },
  );

  return (
    <DetailDrawer
      open={target !== null}
      onClose={onClose}
      size="large"
      title={(row) =>
        `${target?.mode === 'ship' ? '订单发货' : '物流详情'}${row ? ` ${row.orderNo}` : ''}`
      }
      query={order}
    >
      {(row) =>
        target ? (
          <ShipPanel
            key={`${target.orderId}-${target.mode}`}
            id={row.id}
            order={row}
            loading={false}
            mode={target.mode}
            autoOpenShip={target.mode === 'ship'}
          />
        ) : null
      }
    </DetailDrawer>
  );
}
