import { systemFailedJobResolve } from '@shop/contracts/system/system.jobs.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/** `/admin-api/failed-jobs/:id/resolve` — marks one failed job 已处理. */
export const POST = handle(systemFailedJobResolve, async (ctx, { params }) => {
  const result = await system.failedJobResolve(ctx, params.id);
  ctx.audit(`failed-job:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
