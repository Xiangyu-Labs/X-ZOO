import { decorDraftSave } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../src/server';

/** The editor's save, optimistically locked on `version`. */
export const PUT = handle(decorDraftSave, async (ctx, { params, body }) => {
  const saved = await decor.saveDraft(ctx, { ...params, ...body });
  ctx.audit(`decor:document:${params.id}`);
  return saved;
});

export const dynamic = 'force-dynamic';
