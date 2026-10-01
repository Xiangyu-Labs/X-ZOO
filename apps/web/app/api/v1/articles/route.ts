import { articleListPublic } from '@shop/contracts/cms/cms.storefront.contract';
import { articles } from '@shop/core/cms';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/articles` — published articles only.
 *
 * `categoryId` and `feature=hot|banner` are filters on one query rather than
 * four routes with one `where` swapped, and every one filters on status.
 */
export const GET = handle(articleListPublic, (ctx, { query }) => articles.publicList(ctx, query));

export const dynamic = 'force-dynamic';
