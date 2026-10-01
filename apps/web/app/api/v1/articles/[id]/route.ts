import { articleDetailPublic } from '@shop/contracts/cms/cms.storefront.contract';
import { articles } from '@shop/core/cms';
import { handle } from '../../../../../src/server';

/** Reading an article increments its counter; the response carries the number this read produced. */
export const GET = handle(articleDetailPublic, (ctx, { params }) =>
  articles.publicDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
