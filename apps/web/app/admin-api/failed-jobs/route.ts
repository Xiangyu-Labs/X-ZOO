import { systemFailedJobList } from '@shop/contracts/system/system.jobs.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../src/server';

/** `/admin-api/failed-jobs` — background jobs that used up their retries. */
export const GET = handle(systemFailedJobList, (ctx, { query }) =>
  system.failedJobList(ctx, query),
);

export const dynamic = 'force-dynamic';
