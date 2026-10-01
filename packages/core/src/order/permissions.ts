import { definePermissions } from '../auth/permissions';

/**
 * Order permission atoms.
 *
 * Each one is a job somebody in a shop actually does rather than a CRUD verb:
 *
 *  - support looks orders up (`order:read`) and writes what the customer said
 *    (`order:write` — remark, a corrected address, 确认收货);
 *  - changing what the buyer owes (`order:reprice`) is money, and a role that
 *    may fix an address is not thereby trusted to hand out discounts;
 *  - the warehouse ships (`shipment:write`) and nothing else;
 *  - finance issues invoices (`invoice:*`) and reads the numbers
 *    (`stats:read`), and exporting is its own atom because a CSV of every
 *    buyer's name and phone number leaves the building;
 *  - only a manager files an order away (`order:delete`).
 *
 * `order:order:write` covers the console edits that move no money: an operator
 * trusted to change a shipping address is trusted to leave a remark. 改价 was
 * in it once; migration 0012 gave `order:reprice` to every role that held
 * `order:write` then, so the split took nothing away from anybody. Shipping is
 * split out because "may dispatch goods" is a real, different job.
 *
 * The storefront's own order actions (创建, 取消, 确认收货) have no atom at all:
 * they are `auth: 'user'` and the owner check is the authorisation.
 */
export const orderPermissions = definePermissions(
  'order',
  {
    'order:read': '查看订单',
    'order:write': '订单备注/修改地址/确认收货',
    'order:reprice': '订单改价',
    'order:delete': '删除订单',
    'order:export': '导出订单',
    'shipment:write': '订单发货与撤销发货',
    'invoice:read': '查看发票申请',
    'invoice:write': '开票与驳回',
    'stats:read': '查看订单统计',
  },
  { section: '订单' },
);
