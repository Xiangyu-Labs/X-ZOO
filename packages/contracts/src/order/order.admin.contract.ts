import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import {
  adminOrderDetail,
  adminOrderDetailExample,
  adminOrderListItemExample,
  adminOrderListQuery,
  orderAddressBody,
  orderDeletionsBody,
  orderDeletionsResult,
  orderExportQuery,
  orderExportResult,
  orderIdParams,
  orderPriceBody,
  orderRemarkBody,
  orderStatistics,
  orderStatisticsExample,
  orderStatisticsQuery,
  orderStatusLogExample,
  orderTimeline,
  pagedAdminOrders,
  shipBody,
  shipBodyExample,
  shipment,
  shipmentCancelBody,
  shipmentExample,
  shipmentIdParams,
  shipmentTracking,
  shipmentTrackingExample,
  shipmentUpdateBody,
} from './order.fulfil.schemas';

/**
 * The admin order console — 订单管理.
 *
 * Seventeen routes, and what is absent is absent on purpose:
 *
 *  - there is no order splitting, so no split routes — a partial shipment is
 *    a `shipment` covering some of the lines;
 *  - no receipt printers, express templates or electronic waybills: the shop
 *    has no printer or waybill provider;
 *  - no brokerage screen;
 *  - status changes are the two transitions that actually exist,
 *    `POST …/shipments` and `POST …/receipt`, not a free-form status write;
 *  - deletion is one soft delete and one batch.
 *
 * Every write is a POSTed sub-resource with its own permission, so the audit
 * log says what was done rather than "an order was updated".
 */

export const orderAdminList = defineRoute({
  id: 'order.adminList',
  method: 'GET',
  path: '/admin-api/orders',
  auth: 'admin',
  permission: 'order:order:read',
  summary: '订单列表',
  tags: ['order'],
  query: adminOrderListQuery,
  response: pagedAdminOrders,
  examples: [
    {
      name: 'unshipped',
      query: { page: 1, pageSize: 20, status: 'paid', fulfillmentStatus: 'unfulfilled' },
      response: { items: [adminOrderListItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'deleted-bin',
      query: { page: 1, pageSize: 20, deleted: 'true' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const orderAdminStatistics = defineRoute({
  id: 'order.adminStatistics',
  method: 'GET',
  path: '/admin-api/orders/statistics',
  auth: 'admin',
  permission: 'order:stats:read',
  summary: '订单统计头部',
  tags: ['order'],
  query: orderStatisticsQuery,
  response: orderStatistics,
  examples: [
    {
      name: 'yesterday',
      query: { from: '2026-02-01T00:00:00+08:00', to: '2026-02-02T00:00:00+08:00' },
      response: orderStatisticsExample,
    },
  ],
});

/**
 * 导出订单.
 *
 * CSV text in a JSON envelope, not a streamed file — see `orderExportResult`
 * for why.
 */
export const orderAdminExport = defineRoute({
  id: 'order.adminExport',
  method: 'GET',
  path: '/admin-api/orders/exports',
  auth: 'admin',
  permission: 'order:order:export',
  summary: '导出订单（CSV）',
  tags: ['order'],
  query: orderExportQuery,
  response: orderExportResult,
  examples: [
    {
      name: 'orders-sheet',
      query: { kindOfExport: 'orders', status: 'paid' },
      response: {
        filename: 'orders-20260202.csv',
        contentType: 'text/csv',
        rowCount: 1,
        truncated: false,
        content:
          '订单号,下单时间,买家,收货人,手机号,商品数,实付金额,订单状态,发货状态\n' +
          '202602011000000010123456,2026-02-01 10:00:00,张三,张三,13800138000,2,118.00,已支付,未发货\n',
      },
    },
  ],
});

export const orderAdminDetail = defineRoute({
  id: 'order.adminDetail',
  method: 'GET',
  path: '/admin-api/orders/:id',
  auth: 'admin',
  permission: 'order:order:read',
  summary: '订单详情',
  tags: ['order'],
  params: orderIdParams,
  response: adminOrderDetail,
  errors: ['ORDER_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '9001' }, response: adminOrderDetailExample }],
});

/** 订单记录 — the `order_status_logs` timeline, newest first. */
export const orderAdminTimeline = defineRoute({
  id: 'order.adminTimeline',
  method: 'GET',
  path: '/admin-api/orders/:id/status-logs',
  auth: 'admin',
  permission: 'order:order:read',
  summary: '订单状态记录',
  tags: ['order'],
  params: orderIdParams,
  response: orderTimeline,
  errors: ['ORDER_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '9001' }, response: { items: [orderStatusLogExample] } }],
});

export const orderAdminRemark = defineRoute({
  id: 'order.adminRemark',
  method: 'POST',
  path: '/admin-api/orders/:id/remark',
  auth: 'admin',
  permission: 'order:order:write',
  summary: '订单备注',
  tags: ['order'],
  params: orderIdParams,
  body: orderRemarkBody,
  response: adminOrderDetail,
  errors: ['ORDER_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '9001' },
      body: { adminRemark: '客户电话确认周末送达' },
      response: { ...adminOrderDetailExample, adminRemark: '客户电话确认周末送达' },
    },
  ],
});

/** 改价, before payment only. The server recomputes; it never takes a total. */
export const orderAdminAdjustPrice = defineRoute({
  id: 'order.adminAdjustPrice',
  method: 'POST',
  path: '/admin-api/orders/:id/price',
  auth: 'admin',
  permission: 'order:order:reprice',
  summary: '订单改价',
  tags: ['order'],
  params: orderIdParams,
  body: orderPriceBody,
  response: adminOrderDetail,
  errors: [
    'ORDER_NOT_FOUND',
    'ORDER_PRICE_NOT_ADJUSTABLE',
    'ORDER_PRICE_INVALID',
    'ORDER_PAYMENT_STATE_UNKNOWN',
  ],
  examples: [
    {
      name: 'ten-off-and-free-shipping',
      params: { id: '9001' },
      body: { operatorDiscount: '10.00', freightAmount: '0.00', reason: '老客户' },
      response: {
        ...adminOrderDetailExample,
        status: 'pending_payment',
        paidAmount: null,
        paidAt: null,
        payExpiresAt: '2026-02-01T10:30:00+08:00',
        freightAmount: '0.00',
        couponDiscount: '20.00',
        payableAmount: '100.00',
        items: [
          {
            ...adminOrderDetailExample.items[0]!,
            discountAmount: '20.00',
            totalAmount: '100.00',
          },
        ],
      },
    },
  ],
});

export const orderAdminUpdateAddress = defineRoute({
  id: 'order.adminUpdateAddress',
  method: 'POST',
  path: '/admin-api/orders/:id/address',
  auth: 'admin',
  permission: 'order:order:write',
  summary: '修改收货地址',
  tags: ['order'],
  params: orderIdParams,
  body: orderAddressBody,
  response: adminOrderDetail,
  errors: ['ORDER_NOT_FOUND', 'ORDER_ADDRESS_NOT_EDITABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '9001' },
      body: {
        name: '张三',
        phone: '13800138001',
        province: '浙江省',
        city: '杭州市',
        district: '滨江区',
        detail: '江南大道 588 号',
      },
      response: {
        ...adminOrderDetailExample,
        receiver: {
          ...adminOrderDetailExample.receiver,
          addressId: null,
          phone: '13800138001',
          district: '滨江区',
          detail: '江南大道 588 号',
          postCode: null,
        },
      },
    },
  ],
});

/** 删除订单 — soft, and only for an order whose life is over. */
export const orderAdminDelete = defineRoute({
  id: 'order.adminDelete',
  method: 'DELETE',
  path: '/admin-api/orders/:id',
  auth: 'admin',
  permission: 'order:order:delete',
  summary: '删除订单',
  tags: ['order'],
  params: orderIdParams,
  response: z.object({ id: z.string(), deleted: z.literal(true) }),
  errors: ['ORDER_NOT_FOUND', 'ORDER_NOT_DELETABLE'],
  examples: [{ name: 'ok', params: { id: '9001' }, response: { id: '9001', deleted: true } }],
});

/**
 * 批量删除. An order that is still live is skipped and named rather than
 * refusing the whole batch, because an operator selecting thirty rows should
 * not have to find the one bad row by bisection.
 */
export const orderAdminDeleteMany = defineRoute({
  id: 'order.adminDeleteMany',
  method: 'POST',
  path: '/admin-api/orders/deletions',
  auth: 'admin',
  permission: 'order:order:delete',
  summary: '批量删除订单',
  tags: ['order'],
  body: orderDeletionsBody,
  response: orderDeletionsResult,
  examples: [
    {
      name: 'one-skipped',
      body: { ids: ['9001', '9002', '9003'] },
      response: { deleted: 2, skippedIds: ['9003'] },
    },
  ],
});

// ---------------------------------------------------------------------------
// shipping
// ---------------------------------------------------------------------------

export const orderAdminShipments = defineRoute({
  id: 'order.adminShipments',
  method: 'GET',
  path: '/admin-api/orders/:id/shipments',
  auth: 'admin',
  permission: 'order:order:read',
  summary: '订单发货单列表',
  tags: ['order'],
  params: orderIdParams,
  response: z.object({ items: z.array(shipment) }),
  errors: ['ORDER_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '9001' }, response: { items: [shipmentExample] } }],
});

/**
 * 发货.
 *
 * One POST covers express, 无需物流 (`merchant_delivery` without a courier is
 * still a `merchant_delivery`) and manual virtual delivery, because all three
 * write the same three things: a `shipments` row, its `shipment_items`, and
 * `order_items.shipped_quantity`. Shipping the last outstanding unit is what
 * moves the order to `shipped`; nothing else does.
 */
export const orderAdminShip = defineRoute({
  id: 'order.adminShip',
  method: 'POST',
  path: '/admin-api/orders/:id/shipments',
  auth: 'admin',
  permission: 'order:shipment:write',
  summary: '订单发货',
  tags: ['order'],
  params: orderIdParams,
  body: shipBody,
  response: shipment,
  status: 201,
  errors: [
    'ORDER_NOT_FOUND',
    'ORDER_NOT_SHIPPABLE',
    'ORDER_SHIP_QUANTITY_EXCEEDED',
    'ORDER_SHIP_LINE_INVALID',
    'ORDER_VIRTUAL_AUTO_DELIVERED',
    'ORDER_GROUPBUY_NOT_READY',
    'ORDER_EXPRESS_COMPANY_NOT_FOUND',
  ],
  examples: [
    {
      name: 'express-everything',
      params: { id: '9001' },
      body: shipBodyExample,
      response: shipmentExample,
    },
    {
      name: 'partial-merchant-delivery',
      params: { id: '9001' },
      body: {
        deliveryMode: 'merchant_delivery',
        lines: [{ orderItemId: '7001', quantity: 1 }],
        courierName: '王师傅',
        courierPhone: '13900139000',
        remark: '同城当日达',
      },
      response: {
        ...shipmentExample,
        id: '4002',
        shipmentNo: 'SH20260201100000001235',
        deliveryMode: 'merchant_delivery',
        expressCompanyId: null,
        expressCompanyName: null,
        trackingNo: null,
        courierName: '王师傅',
        courierPhone: '13900139000',
        remark: '同城当日达',
        lines: [{ ...shipmentExample.lines[0]!, quantity: 1 }],
      },
    },
  ],
});

export const orderAdminUpdateShipment = defineRoute({
  id: 'order.adminUpdateShipment',
  method: 'PATCH',
  path: '/admin-api/shipments/:id',
  auth: 'admin',
  permission: 'order:shipment:write',
  summary: '修改发货信息',
  tags: ['order'],
  params: shipmentIdParams,
  body: shipmentUpdateBody,
  response: shipment,
  errors: [
    'ORDER_SHIPMENT_NOT_FOUND',
    'ORDER_SHIPMENT_NOT_EDITABLE',
    'ORDER_EXPRESS_COMPANY_NOT_FOUND',
  ],
  examples: [
    {
      name: 'fix-the-tracking-number',
      params: { id: '4001' },
      body: { trackingNo: 'SF9999999999999' },
      response: { ...shipmentExample, trackingNo: 'SF9999999999999' },
    },
  ],
});

/**
 * 撤销发货. Puts `shipped_quantity` back and walks the order's fulfilment
 * status backwards — the only way to correct which lines went out.
 */
export const orderAdminCancelShipment = defineRoute({
  id: 'order.adminCancelShipment',
  method: 'POST',
  path: '/admin-api/shipments/:id/cancel',
  auth: 'admin',
  permission: 'order:shipment:write',
  summary: '撤销发货',
  tags: ['order'],
  params: shipmentIdParams,
  body: shipmentCancelBody,
  response: shipment,
  errors: ['ORDER_SHIPMENT_NOT_FOUND', 'ORDER_SHIPMENT_NOT_EDITABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '4001' },
      body: { reason: '运单号填错了' },
      response: {
        ...shipmentExample,
        status: 'cancelled',
        cancelledAt: '2026-02-02T10:00:00+08:00',
      },
    },
  ],
});

/** 物流查询 — through the logistics provider; `available: false` while none is configured. */
export const orderAdminShipmentTracking = defineRoute({
  id: 'order.adminShipmentTracking',
  method: 'GET',
  path: '/admin-api/shipments/:id/tracking',
  auth: 'admin',
  permission: 'order:order:read',
  summary: '物流轨迹',
  tags: ['order'],
  params: shipmentIdParams,
  response: shipmentTracking,
  errors: ['ORDER_SHIPMENT_NOT_FOUND'],
  examples: [
    { name: 'in-transit', params: { id: '4001' }, response: shipmentTrackingExample },
    {
      name: 'no-provider-configured',
      params: { id: '4001' },
      response: {
        ...shipmentTrackingExample,
        available: false,
        state: 'unknown',
        traces: [],
      },
    },
  ],
});

// The 物流公司 picker is `shipping.expressCompanyPicker` in
// `contracts/src/shipping/`, under the same `order:order:read` permission.

/**
 * 确认收货, by an operator.
 *
 * The customer phoned to say the parcel arrived. It is the *same* conditional
 * `shipped -> received` transition the buyer's own button and the auto-receive
 * job run, so all three racing each other is one transition and one set of
 * effects — which is the point of putting it behind the state machine rather
 * than behind three copies of an UPDATE.
 */
export const orderAdminConfirmReceipt = defineRoute({
  id: 'order.adminConfirmReceipt',
  method: 'POST',
  path: '/admin-api/orders/:id/receipt',
  auth: 'admin',
  permission: 'order:order:write',
  summary: '后台确认收货',
  tags: ['order'],
  params: orderIdParams,
  body: z.object({}).default({}),
  response: adminOrderDetail,
  errors: ['ORDER_NOT_FOUND', 'ORDER_NOT_RECEIVABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '9001' },
      body: {},
      response: {
        ...adminOrderDetailExample,
        status: 'received',
        fulfillmentStatus: 'fulfilled',
        shippedAt: '2026-02-02T09:00:00+08:00',
        receivedAt: '2026-02-04T18:00:00+08:00',
        autoReceiveAt: null,
      },
    },
  ],
});
