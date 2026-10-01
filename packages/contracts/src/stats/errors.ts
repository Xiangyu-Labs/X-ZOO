import { defineErrors } from '../_conventions/errors';

/**
 * Statistics error codes.
 *
 * There are only two, and both are about the *question*, not the data: every
 * figure on every page is a read-only aggregate that either exists or is zero.
 * A statistics page has no state to lose a race with.
 */
export const statsErrors = defineErrors({
  /** `from` is after `to`, or the window is longer than three years. `details` carries `{ maxDays }`. */
  STATS_RANGE_INVALID: { status: 422, message: '统计时间范围不正确' },
  /** The filter matched more rows than the export cap even after truncation logic. */
  STATS_EXPORT_TOO_LARGE: { status: 422, message: '导出数据过多，请缩小时间范围' },
});

export type StatsErrorCode = keyof typeof statsErrors;
