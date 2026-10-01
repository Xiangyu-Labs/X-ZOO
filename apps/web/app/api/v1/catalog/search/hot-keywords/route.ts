import { catalogHotKeywords } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/catalog/search/hot-keywords` — 热门搜索.
 *
 * Derived from what shoppers actually searched *and found*: a keyword that
 * returned nothing is never promoted.
 */

export const GET = handle(catalogHotKeywords, (ctx) => catalog.hotKeywords(ctx));

export const dynamic = 'force-dynamic';
