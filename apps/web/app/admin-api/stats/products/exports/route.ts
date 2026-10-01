import { statsProductExport } from '@shop/contracts/stats/stats.admin.contract';
import * as stats from '@shop/core/stats';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/stats/products/exports` — 商品统计导出.
 *
 * CSV inside a JSON envelope; the page turns `content` into a
 * download. Its own permission atom: reading the page and walking out with the
 * window as a file are different acts.
 */
export const GET = handle(statsProductExport, async (ctx, { query }) => {
  const result = await stats.productExport(ctx, query);
  // Written to the operation log although it is a read: who took the file.
  ctx.audit(`stats-product-export:${result.rowCount}`);
  return result;
});

export const dynamic = 'force-dynamic';
