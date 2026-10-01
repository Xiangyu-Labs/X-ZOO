import { decorRollback } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../../../src/server';

/** Republishes an old revision's content as a new revision. */
export const POST = handle(decorRollback, async (ctx, { params, body }) => {
  const restored = await decor.rollback(ctx, { ...params, ...body });
  ctx.audit(`decor:document:${params.id}:revision:${restored.revision.number}`);
  return restored;
});

export const dynamic = 'force-dynamic';
