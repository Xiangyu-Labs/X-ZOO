import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';
import type { Ctx } from '../kernel/context';

/**
 * The `refund` config group: where returned goods go, and the canned reasons.
 *
 * Small on purpose. After-sales *policy* — who may approve, what the ceiling is,
 * whether freight comes back — is code and database invariants, not settings,
 * because every one of those is something a wrong value would turn into lost
 * money. What is left is genuinely per-shop: the return address printed on the
 * buyer's screen once a `return_and_refund` is approved.
 *
 * Nothing here is secret, so the whole group is readable by anyone holding
 * `refund:config:read`. Writing it takes `refund:config:write` (derived by the
 * config service from the `:read` atom), because the return address decides
 * where buyers send goods: it is not something the remark atom
 * (`refund:request:write`) or an approval atom may change.
 */

/**
 * A stored text setting.
 *
 * `config_values.value` is `jsonb`. Parsed twice on the way out, a string that
 * is all digits — a 商户号, a phone number — would come back as a *number*;
 * `@shop/db` has json and jsonb reach drizzle as text and parses them once, so
 * this is a plain string. The round trip is covered by a test in every group
 * the payment and refund domains own, because the failure mode is silent: the
 * field falls back to its default and the shop reports 支付尚未配置 with a
 * filled-in form.
 */
const configText = (max: number) => z.string().max(max).default('');

export const refundConfig = defineConfigGroup({
  group: 'refund',
  title: '售后设置',
  description: '退货收件信息与售后期限。',
  category: 'trade',
  permission: 'refund:config:read',
  schema: z.object({
    /** Consignee for returned goods. Empty means "no address configured yet". */
    returnName: configText(32),
    returnPhone: configText(20),
    returnAddress: configText(255),
    /**
     * How long a buyer may still open after-sales on a completed order, in
     * days. `0` disables the window entirely.
     */
    afterSaleDays: z.number().int().min(0).max(365).default(0),
  }),
  ui: {
    returnName: { label: '退货收件人', type: 'text', section: '售后', order: 10 },
    returnPhone: { label: '退货联系电话', type: 'text', section: '售后', order: 20 },
    returnAddress: { label: '退货地址', type: 'textarea', section: '售后', order: 30 },
    afterSaleDays: {
      label: '售后期限',
      type: 'number',
      unit: 'days',
      help: '0 表示不限制',
      section: '售后',
      order: 40,
    },
  },
});

export type RefundConfig = z.infer<typeof refundConfig.schema>;

export interface ReturnAddress {
  name: string;
  phone: string;
  address: string;
}

/**
 * The address the buyer is told to ship back to, or `null` when the shop has
 * not configured one. Never a half-filled object: a return label with a name
 * and no street is worse than an empty panel telling the buyer to ask support.
 */
export async function returnAddress(ctx: Ctx): Promise<ReturnAddress | null> {
  const config = await ctx.config.get(refundConfig);
  if (config.returnName === '' || config.returnPhone === '' || config.returnAddress === '') {
    return null;
  }
  return {
    name: config.returnName,
    phone: config.returnPhone,
    address: config.returnAddress,
  };
}
