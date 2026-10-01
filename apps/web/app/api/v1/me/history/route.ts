import {
  catalogHistoryClear,
  catalogHistoryList,
} from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/api/v1/me/history` — 我的足迹, newest visit per product. */

export const GET = handle(catalogHistoryList, (ctx, { query }) => catalog.historyList(ctx, query));

export const DELETE = handle(catalogHistoryClear, (ctx) => catalog.historyClear(ctx));

export const dynamic = 'force-dynamic';
