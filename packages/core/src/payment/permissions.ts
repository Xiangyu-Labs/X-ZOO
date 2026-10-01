import { definePermissions } from '../auth/permissions';

/**
 * Payment permission atoms.
 *
 * The split follows the blast radius, not the screens. Reading an attempt or a
 * capital flow tells you what happened; `exception:handle` *moves money back
 * out of the merchant account* and `effect:handle` re-runs a side effect that
 * may message a customer, so neither belongs to whoever can read the finance
 * report. `config:write` is alone because it holds the merchant private key.
 */
export const paymentPermissions = definePermissions(
  'payment',
  {
    'attempt:read': '查看支付记录',
    'exception:read': '查看异常支付',
    'exception:handle': '处理异常支付（退款/忽略）',
    'flow:read': '查看资金流水',
    'effect:handle': '重试待处理任务',
    'config:write': '配置微信支付',
  },
  { section: '交易' },
);
