import { defineMenu } from './types';

/**
 * 交易 — payment and after-sales.
 *
 * One group rather than two, because an operator chasing a customer's money
 * moves between them constantly: the refund that failed, the attempt it came
 * from, the flow row that proves what actually moved. Splitting 支付 and 售后
 * into separate top-level groups would put two halves of one investigation in
 * two places.
 *
 * The order inside is the order of urgency, not of the data model. 售后单 is
 * first because a person is waiting on it; 待处理任务 is last because it is the
 * screen you open when one of the others has gone wrong.
 *
 * `permission` here only decides what the sider shows. The server re-checks the
 * atom declared on each route, and both lists come from `paymentPermissions` /
 * `refundPermissions` in `@shop/core`.
 */
export default defineMenu({
  key: 'trade',
  label: '交易',
  icon: 'PayCircleOutlined',
  order: 250,
  children: [
    {
      key: 'trade.refunds',
      label: '售后单',
      path: '/admin/trade/refunds',
      permission: 'refund:request:read',
      order: 10,
    },
    {
      key: 'trade.paymentExceptions',
      label: '异常支付',
      path: '/admin/trade/payment-exceptions',
      permission: 'payment:exception:read',
      order: 20,
    },
    {
      key: 'trade.paymentAttempts',
      label: '支付记录',
      path: '/admin/trade/payment-attempts',
      permission: 'payment:attempt:read',
      order: 30,
    },
    {
      key: 'trade.capitalFlows',
      label: '资金流水',
      path: '/admin/trade/capital-flows',
      permission: 'payment:flow:read',
      order: 40,
    },
    {
      key: 'trade.effects',
      label: '待处理任务',
      path: '/admin/trade/effects',
      permission: 'payment:effect:handle',
      order: 50,
    },
  ],
});
