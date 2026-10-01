import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `stats` — the knobs the statistics screens have.
 *
 * The first two exist because a statistics page is the easiest place in an admin to ask
 * the database for something enormous by accident:
 *
 * - `exportMaxRows` caps a CSV export. The route answers with the file inside a
 *   JSON envelope, so the whole thing is built in memory before it is sent; a
 *   cap is not a nicety. Over the cap the export refuses with
 *   `STATS_EXPORT_TOO_LARGE` and asks for a narrower window rather than quietly
 *   handing back a truncated file that looks complete.
 * - `cacheSeconds` is how long a computed block is reused. 60 by default: long
 *   enough that a dashboard being watched during a sale does not re-run every
 *   aggregate on every poll, short enough that an operator refreshing after a
 *   fix sees the new number within a minute. `0` turns caching off, which is
 *   what a shop debugging a figure wants.
 *
 * `visitRetentionDays` is how long page views (`user_visits`) are kept; the
 * nightly `user.pruneVisits` job deletes what is older. 400 by default, so a
 * month can still be compared with the same month a year earlier. Past the
 * window 访客数 / 浏览量 read 0, which is why the floor is a quarter rather than
 * a week.
 */
export const statsConfig = defineConfigGroup({
  group: 'stats',
  title: '统计设置',
  description: '统计缓存、导出上限与访问记录保留。',
  category: 'rules',
  permission: 'system:config:read',
  schema: z.object({
    // The floor is deliberately low: a shop that wants exports effectively
    // off should be able to say so, and a cap that cannot go below a month of
    // daily buckets would make the 交易统计 refusal unreachable.
    exportMaxRows: z.number().int().min(10).max(50_000).default(2000),
    cacheSeconds: z.number().int().min(0).max(3600).default(60),
    visitRetentionDays: z.number().int().min(92).max(3660).default(400),
  }),
  ui: {
    exportMaxRows: {
      label: '导出最大行数',
      type: 'number',
      help: '超过此行数的导出会被拒绝，请缩小时间范围',
      order: 1,
    },
    cacheSeconds: {
      label: '统计缓存',
      type: 'number',
      unit: 'seconds',
      help: '0 表示不缓存；统计页面的每个区块按时间范围缓存这么久',
      order: 2,
    },
    visitRetentionDays: {
      label: '访问记录保留天数',
      type: 'number',
      unit: 'days',
      help: '每天凌晨删除更早的页面访问记录；超出范围的访客数、浏览量显示为 0。同比需要至少 366 天',
      order: 3,
    },
  },
});
