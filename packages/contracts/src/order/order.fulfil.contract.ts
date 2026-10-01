import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import { orderRefParams } from './order.ref.schemas';
import { orderDetail, orderDetailExample } from './schemas';
import {
  shipment,
  shipmentExample,
  shipmentIdParams,
  shipmentTracking,
  shipmentTrackingExample,
} from './order.fulfil.schemas';

/**
 * What the buyer does with a shipped order: look at the parcels and confirm
 * receipt.
 *
 * Three routes. The shipments are their own sub-resource, not a blob inside the
 * order detail, because an order can have several of them: partial shipment is
 * a first-class thing.
 *
 * `POST …/receipt` is the same `OrderStateMachine.transition(shipped ->
 * received)` the auto-receive job runs, so the buyer tapping 确认收货 at the
 * exact moment the job fires is one transition and one set of effects, decided
 * by the affected row count.
 */

export const orderConfirmReceipt = defineRoute({
  id: 'order.confirmReceipt',
  method: 'POST',
  path: '/api/v1/orders/:id/receipt',
  auth: 'user',
  summary: '确认收货',
  tags: ['order'],
  params: orderRefParams,
  /**
   * `via: 'wechat-component'` when the mini program's 确认收货 component
   * (`openBusinessView('weappOrderConfirm')`) reported `success`. The server
   * does not take the client's word for it: it asks WeChat (`get_order`) and
   * only then moves the order (C07). Without it, the plain 确认收货.
   */
  body: z.object({ via: z.enum(['wechat-component']).optional() }).default({}),
  response: orderDetail,
  errors: ['ORDER_NOT_FOUND', 'ORDER_NOT_RECEIVABLE', 'ORDER_WECHAT_RECEIPT_UNCONFIRMED'],
  examples: [
    {
      name: 'ok',
      params: { id: '9001' },
      body: {},
      response: {
        ...orderDetailExample,
        status: 'received',
        fulfillmentStatus: 'fulfilled',
        paidAmount: '118.00',
        payExpiresAt: null,
        paidAt: '2026-02-01T10:03:00+08:00',
        shippedAt: '2026-02-02T09:00:00+08:00',
        receivedAt: '2026-02-04T18:00:00+08:00',
        items: [{ ...orderDetailExample.items[0]!, shippedQuantity: 2 }],
      },
    },
    {
      name: 'wechat-component',
      params: { id: '9001' },
      body: { via: 'wechat-component' },
      response: {
        ...orderDetailExample,
        status: 'received',
        fulfillmentStatus: 'fulfilled',
        paidAmount: '118.00',
        payExpiresAt: null,
        paidAt: '2026-02-01T10:03:00+08:00',
        shippedAt: '2026-02-02T09:00:00+08:00',
        receivedAt: '2026-02-04T18:00:00+08:00',
        items: [{ ...orderDetailExample.items[0]!, shippedQuantity: 2 }],
      },
    },
  ],
});

export const orderMyShipments = defineRoute({
  id: 'order.myShipments',
  method: 'GET',
  path: '/api/v1/orders/:id/shipments',
  auth: 'user',
  summary: '订单包裹',
  tags: ['order'],
  params: orderRefParams,
  response: z.object({ items: z.array(shipment) }),
  errors: ['ORDER_NOT_FOUND'],
  examples: [
    { name: 'one-parcel', params: { id: '9001' }, response: { items: [shipmentExample] } },
    { name: 'nothing-shipped-yet', params: { id: '9001' }, response: { items: [] } },
  ],
});

export const orderMyShipmentTracking = defineRoute({
  id: 'order.myShipmentTracking',
  method: 'GET',
  path: '/api/v1/shipments/:id/tracking',
  auth: 'user',
  summary: '物流轨迹',
  tags: ['order'],
  params: shipmentIdParams,
  response: shipmentTracking,
  errors: ['ORDER_SHIPMENT_NOT_FOUND'],
  examples: [{ name: 'in-transit', params: { id: '4001' }, response: shipmentTrackingExample }],
});
