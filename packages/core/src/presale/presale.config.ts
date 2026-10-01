import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * 预售设置.
 *
 * Deliberately small. Everything a campaign needs — its price, its window, its
 * 发货承诺, its quota — is a column on the activity, because it differs per
 * campaign; what is left over is how the window sweep behaves, and that is a
 * property of the shop.
 *
 * The group declares the *read* atom, as every config group does; the settings
 * service derives the write gate from it (`writePermissionFor`), so seeing this
 * form needs `presale:activity:read` and saving it needs `presale:activity:write`.
 */
export const presaleConfig = defineConfigGroup({
  group: 'presale',
  title: '预售设置',
  description: '预售活动的下架与开售处理。',
  category: 'trade',
  permission: 'presale:activity:read',
  schema: z.object({
    /** Campaigns one sweep pass may close. Bounds the statement, nothing more. */
    windowSweepLimit: z.number().int().min(1).max(2_000).default(200),
    /**
     * How far back the "window opened" half of the sweep looks.
     *
     * The schema has no `scheduled` status, so opening a campaign changes no
     * row — the storefront list already filters on `start_at <= now < end_at`.
     * What the open half does is record the event exactly once, and the effects
     * ledger's `UNIQUE (scope, scope_id, event_type)` is what makes it exactly
     * once. This window is only there so the query stays bounded: a campaign
     * that started a month ago is not news.
     */
    windowOpenLookbackHours: z.number().int().min(1).max(720).default(24),
  }),
  ui: {
    windowSweepLimit: {
      label: '每次下架预售活动数量',
      type: 'number',
      help: '定时任务每次最多结束多少个已过期的预售活动',
      section: '活动窗口',
    },
    windowOpenLookbackHours: {
      label: '开售事件回溯小时数',
      type: 'number',
      unit: 'hours',
      help: '定时任务向前回溯多久，为刚刚开售的活动补记一次开售事件；不影响前台是否可买',
      section: '活动窗口',
    },
  },
});

export type PresaleConfig = z.infer<typeof presaleConfig.schema>;
