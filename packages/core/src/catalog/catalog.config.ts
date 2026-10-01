import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * Catalog settings.
 *
 * Every field carries a `.default()`, because a group must be readable before
 * anybody has ever saved it — a fresh install has no `config_values` rows and
 * still has to boot.
 *
 * Registration is a side effect of this module being imported, and
 * `core/src/catalog/index.ts` exports it, so `@shop/core/catalog` is enough to
 * make the group visible to the generic admin config screen
 * (`docs/conventions.md`: "`packages/core/src/<domain>/<group>.config.ts`,
 * registered from the domain's `index.ts`").
 */
export const catalogConfig = defineConfigGroup({
  group: 'catalog',
  title: '商品设置',
  description: '库存预警、自动好评、搜索热词与足迹。',
  category: 'rules',
  permission: 'catalog:product:read',
  schema: z.object({
    /**
     * A SKU at or below this many units shows up in 库存预警. Zero turns the
     * list off rather than warning about everything.
     */
    stockWarningThreshold: z.number().int().min(0).max(100_000).default(10),

    /**
     * Days after an order is completed before the auto-review job writes a
     * five-star review for its lines. Zero turns the job into a no-op.
     */
    autoReviewDays: z.number().int().min(0).max(365).default(7),
    /** What that automatic review says. */
    autoReviewContent: z.string().max(500).default('此用户没有填写评价。'),

    /**
     * Whether a shopper's review waits for an operator.
     *
     * `false` (the default, and what the shop does today) publishes on submit.
     * Turning it on makes new reviews `pending` — nothing else changes, because
     * every storefront read already filters on `status = 'published'`.
     */
    reviewRequiresAudit: z.boolean().default(false),

    /** How many hot search words the storefront asks for. */
    hotKeywordLimit: z.number().int().min(0).max(50).default(10),
    /** The window `catalog.hotKeywords` counts over. */
    hotKeywordDays: z.number().int().min(1).max(365).default(30),
    /** How many of a shopper's own recent searches 搜索历史 keeps. */
    searchHistoryLimit: z.number().int().min(0).max(100).default(20),

    /**
     * How long a browsed product stays in 我的足迹, and how far back the
     * pruning job deletes `product_events` rows of kind `view`.
     */
    browseHistoryDays: z.number().int().min(1).max(3650).default(90),

    /** Hard ceiling on one product export. The route refuses more. */
    exportRowLimit: z.number().int().min(100).max(50_000).default(10_000),
  }),
  ui: {
    stockWarningThreshold: {
      label: '库存预警值',
      type: 'number',
      help: '规格库存小于等于该值时进入库存预警列表；填 0 关闭预警。',
      section: '库存',
      order: 10,
    },
    autoReviewDays: {
      label: '自动好评天数',
      type: 'number',
      unit: 'days',
      help: '订单完成后多少天未评价则自动给出好评；填 0 关闭。',
      section: '评价',
      order: 10,
    },
    autoReviewContent: {
      label: '自动好评内容',
      type: 'textarea',
      section: '评价',
      order: 20,
    },
    reviewRequiresAudit: {
      label: '评价需要审核',
      type: 'switch',
      help: '开启后买家评价先进入待审核，审核通过才在商品页展示。',
      section: '评价',
      order: 30,
    },
    hotKeywordLimit: { label: '热门搜索词数量', type: 'number', section: '搜索', order: 10 },
    hotKeywordDays: {
      label: '热词统计天数',
      type: 'number',
      unit: 'days',
      help: '热门搜索词按最近多少天的搜索记录统计。',
      section: '搜索',
      order: 20,
    },
    searchHistoryLimit: { label: '搜索历史条数', type: 'number', section: '搜索', order: 30 },
    browseHistoryDays: {
      label: '足迹保留天数',
      type: 'number',
      unit: 'days',
      help: '超过该天数的浏览记录会被定时任务清理。',
      section: '搜索',
      order: 40,
    },
    exportRowLimit: { label: '导出条数上限', type: 'number', section: '库存', order: 20 },
  },
});

export type CatalogConfig = z.infer<typeof catalogConfig.schema>;
