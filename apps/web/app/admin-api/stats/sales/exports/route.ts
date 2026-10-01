import { statsSalesExport } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/stats/sales/exports` — 分类销售导出, one row per top-level category.
 *
 * Refuses with `STATS_EXPORT_TOO_LARGE` rather than truncating, like the
 * 交易统计 export.
 */
export const GET = handle(statsSalesExport, async (ctx, { query }) => {
  const result = await stats.salesExport(ctx, query);
  // Written to the operation log although it is a read: who took the file.
  ctx.audit(`stats-sales-export:${result.rowCount}`);
  return result;
});

export const dynamic = 'force-dynamic';
