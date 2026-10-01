import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * The fulfilment half of the order settings.
 *
 * A **second** group next to checkout's `order`, rather than more fields inside
 * it: each group is owned by the code that reads it, so the checkout and
 * fulfilment settings change independently. Operators see two sections on the
 * same settings page (下单 / 发货收货).
 */
export const orderFulfilConfig = defineConfigGroup({
  group: 'order-fulfil',
  title: '发货与收货设置',
  description: '自动确认收货、评价期与订单导出上限。',
  category: 'trade',
  schema: z.object({
    /**
     * Days a shipped order waits before the system confirms receipt for the
     * buyer.
     */
    autoReceiveDays: z.number().int().min(1).max(90).default(10),
    /** Orders the auto-receive sweep takes per pass; the delayed job does the real work. */
    autoReceiveSweepLimit: z.number().int().min(1).max(2_000).default(200),
    /**
     * Days a `received` order waits for a review before it becomes `completed`.
     * In days, like every other timer in this group.
     */
    reviewWindowDays: z.number().int().min(0).max(90).default(7),
    completionSweepLimit: z.number().int().min(1).max(2_000).default(200),
    /** Rows one 导出 may produce. Beyond this the answer is truncated and says so. */
    exportMaxRows: z.number().int().min(100).max(20_000).default(2_000),
  }),
  ui: {
    autoReceiveDays: {
      label: '自动确认收货天数',
      type: 'number',
      unit: 'days',
      help: '发货后超过该天数，系统自动确认收货',
      section: '发货收货',
    },
    autoReceiveSweepLimit: {
      label: '自动确认收货每次处理数量',
      type: 'number',
      help: '兜底扫描每次处理的订单数，正常情况下由单笔延时任务先行确认',
      section: '发货收货',
    },
    reviewWindowDays: {
      label: '评价期天数',
      type: 'number',
      unit: 'days',
      help: '确认收货后超过该天数订单变为已完成，填 0 表示确认收货即完成',
      section: '发货收货',
    },
    completionSweepLimit: {
      label: '订单完成每次处理数量',
      type: 'number',
      section: '发货收货',
    },
    exportMaxRows: {
      label: '单次导出最大行数',
      type: 'number',
      help: '超过该行数的导出会被截断，请缩小筛选范围',
      section: '导出',
    },
  },
});
