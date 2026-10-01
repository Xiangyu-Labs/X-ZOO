import { catalogHistoryRemove } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/api/v1/me/history/deletions` — remove a selection of 足迹 rows. */

export const POST = handle(catalogHistoryRemove, (ctx, { body }) =>
  catalog.historyRemove(ctx, body),
);

export const dynamic = 'force-dynamic';
