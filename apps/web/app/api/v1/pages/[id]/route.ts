import { decorPageResolve } from '@shop/contracts/decor/decor.storefront.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../src/server';
import { pageEtag } from '../_page';

/** A published page by id, or — with `previewToken` — its draft. */
export const GET = handle(decorPageResolve, async (ctx, { params, query }) => {
  const page = await decor.resolveDocument(ctx, {
    id: params.id,
    previewToken: query.previewToken,
    clientVersion: ctx.clientVersion ?? null,
  });
  if (ctx.etag(pageEtag(page), { weak: true })) ctx.notModified();
  return page;
});

export const dynamic = 'force-dynamic';
