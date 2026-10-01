import { definePermissions } from '../auth/permissions';

/**
 * Refund permission atoms.
 *
 * `review` and `execute` are separate because they are different decisions:
 * approving a request says "yes, this customer is owed money", while executing
 * one sends it. In a shop where customer service approves and finance pays,
 * that boundary is the control; in a small shop one role holds both, which is a
 * grant, not a code change.
 *
 * `config:read` / `config:write` gate the 售后设置 group, rather than the
 * remark atom: the config service derives a distinct write atom only from a
 * `:read` one, so borrowing `request:write` would make "add a remark" also mean
 * "change the address buyers post their returns to". Redirecting goods is not a
 * reviewer's decision; `config:write` belongs to whoever runs after-sales, and
 * holding it grants nothing on the requests themselves.
 */
export const refundPermissions = definePermissions(
  'refund',
  {
    'request:read': '查看售后单',
    'request:review': '审核售后单（同意/拒绝）',
    'request:execute': '执行退款（收货/重试）',
    'request:write': '备注售后单',
    'config:read': '查看售后设置',
    'config:write': '修改售后设置（退货地址、售后期限）',
  },
  { section: '交易' },
);
