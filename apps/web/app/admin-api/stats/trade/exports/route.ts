import { statsTradeExport } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/stats/trade/exports` — 交易统计导出, one row per bucket.
 *
 * Refuses with `STATS_EXPORT_TOO_LARGE` rather than truncating: the tail of a
 * time series is not optional, and a file missing it looks complete.
 */
export const GET = handle(statsTradeExport, async (ctx, { query }) => {
  const result = await stats.tradeExport(ctx, query);
  // Written to the operation log although it is a read: who took the file.
  ctx.audit(`stats-trade-export:${result.rowCount}`);
  return result;
});

export const dynamic = 'force-dynamic';
