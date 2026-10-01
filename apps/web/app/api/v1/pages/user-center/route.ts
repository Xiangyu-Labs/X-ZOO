import { decorPageUserCenter } from '@shop/contracts/decor/decor.storefront.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../src/server';
import { pageEtag } from '../_page';

/** 个人中心: the designated one, or the built-in page. Never 404s. */
export const GET = handle(decorPageUserCenter, async (ctx) => {
  const page = await decor.resolveUserCenter(ctx, { clientVersion: ctx.clientVersion ?? null });
  if (ctx.etag(pageEtag(page), { weak: true })) ctx.notModified();
  return page;
});

export const dynamic = 'force-dynamic';
