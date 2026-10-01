import type { FailedJobItem, FailedJobListQuery } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { failedJobExists, pageFailedJobs, resolveFailedJob } from '../kernel/failed-jobs.repo';
import { fromId, toId } from '../kernel/ids';

/**
 * 失败的后台任务: the worker's dead-letter box (`failed_jobs`), which the worker
 * wrote and nobody read. A sweep that fails every retry lands here; this lists
 * them and lets a person mark one handled. Nothing is re-run from here — the
 * sweeps come round again on their own schedule.
 */
export async function failedJobList(
  ctx: Ctx,
  query: FailedJobListQuery,
): Promise<{ items: FailedJobItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await pageFailedJobs(ctx.db, {
    resolved: query.status === 'resolved',
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return {
    items: rows.map((row) => ({
      id: toId(row.id),
      jobName: row.jobName,
      error: row.error,
      // A row recorded before summaries were written has only the raw text.
      errorSummary: row.errorSummary ?? `后台任务没有完成，${UNEXPLAINED}`,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Marks one row 已处理. Guarded on `resolved_at is null`, so two people pressing
 * it together resolve it once, and the second is told `resolved: false`.
 */
export async function failedJobResolve(ctx: Ctx, id: string): Promise<{ resolved: boolean }> {
  const numeric = fromId(id);
  const changed = await resolveFailedJob(ctx.db, numeric, ctx.clock.now());
  if (changed > 0) return { resolved: true };
  if (!(await failedJobExists(ctx.db, numeric)))
    throw new DomainError('SYSTEM_FAILED_JOB_NOT_FOUND');
  return { resolved: false };
}
