import { defineMenu } from './types';

/**
 * 订单.
 *
 * `order` sits at 200, before 营销 (300) and after the catalogue, because it is
 * where an operator spends their day. 发票 is a child rather than a section of
 * its own: finance opens it from the same place support opens the order list.
 *
 * The atoms here only decide what the sider shows; the server re-checks the
 * one declared on each route. Both lists come from `orderPermissions` in
 * `@shop/core/order/permissions.ts`.
 */
export default defineMenu({
  key: 'order',
  label: '订单',
  icon: 'ShoppingCartOutlined',
  order: 200,
  children: [
    {
      key: 'order.list',
      label: '订单列表',
      path: '/admin/orders',
      permission: 'order:order:read',
      order: 10,
    },
    {
      key: 'order.detail',
      label: '订单详情',
      path: '/admin/orders/:id',
      permission: 'order:order:read',
      hidden: true,
      order: 11,
    },
    {
      key: 'order.invoices',
      label: '发票管理',
      path: '/admin/orders/invoices',
      permission: 'order:invoice:read',
      order: 20,
    },
  ],
});
