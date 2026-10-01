import { decorPublish } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../src/server';

export const POST = handle(decorPublish, async (ctx, { params, body }) => {
  const published = await decor.publish(ctx, { ...params, ...body });
  ctx.audit(`decor:document:${params.id}:revision:${published.revision.number}`);
  return published;
});

export const dynamic = 'force-dynamic';
