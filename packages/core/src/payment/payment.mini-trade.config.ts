import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `wechat-mini-trade` — 小程序发货信息管理 (C07).
 *
 * One switch an operator touches, and four values the admin's 同步 button
 * writes (no `ui` entry, so the settings form never renders them): whether
 * WeChat says the mini program is managed, and which 消息跳转路径 it was last
 * told. They live here rather than in Redis because an operator reading
 * 「已纳入 / 跳转路径」 wants yesterday's answer after a restart too.
 *
 * `uploadEnabled` defaults to **on**. The upload only ever happens for an order
 * paid through the mini program, and a managed mini program whose shipments are
 * not reported has its money frozen — the safe default is to report.
 */
export const miniTradeConfig = defineConfigGroup({
  group: 'wechat-mini-trade',
  title: '小程序发货信息管理',
  description: '小程序发货信息管理：录入方式与微信侧同步状态。',
  category: 'wechat',
  permission: 'payment:config:write',
  schema: z.object({
    uploadEnabled: z.boolean().default(true),
    managed: z.enum(['unknown', 'yes', 'no']).default('unknown'),
    managedCheckedAt: z.string().max(40).default(''),
    msgJumpPath: z.string().max(255).default(''),
    msgJumpPathSetAt: z.string().max(40).default(''),
  }),
  ui: {
    uploadEnabled: {
      label: '录入发货信息',
      type: 'switch',
      help: '小程序支付的订单发货后，自动向微信录入发货信息。被纳入发货信息管理的小程序，不录入则货款冻结',
      order: 1,
    },
  },
});

export type MiniTradeConfig = z.infer<typeof miniTradeConfig.schema>;
