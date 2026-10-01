import {
  catalogClearSearchHistory,
  catalogSearchHistory,
} from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/api/v1/me/search-history` — the shopper's own recent searches. */

export const GET = handle(catalogSearchHistory, (ctx) => catalog.searchHistory(ctx));

export const DELETE = handle(catalogClearSearchHistory, (ctx) => catalog.clearSearchHistory(ctx));

export const dynamic = 'force-dynamic';
