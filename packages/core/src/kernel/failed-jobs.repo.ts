import type { DbOrTx } from '@shop/db';
import { failedJobs } from '@shop/db/schema/system';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

/**
 * The only file that touches `failed_jobs`.
 *
 * A job that exhausts its BullMQ attempts lands here, because the alternative
 * is a Redis key that expires and an operator who never finds out.
 */

export interface FailedJobInput {
  queue: string;
  jobName: string;
  jobId: string | null;
  payload: unknown;
  /** Raw (an exception's message), for 技术详情 and whoever debugs it. */
  error: string;
  /** What staff read, in Chinese (AGENTS.md rule 1). */
  summary: string;
  attempts: number;
  now: Date;
}

export async function recordFailedJob(db: DbOrTx, input: FailedJobInput): Promise<void> {
  await db.insert(failedJobs).values({
    queue: input.queue,
    jobName: input.jobName,
    jobId: input.jobId,
    payload: (input.payload ?? {}) as never,
    // Stored, so it must be short and must never carry a secret.
    error: input.error.slice(0, 2000),
    errorSummary: input.summary.slice(0, 500),
    attempts: input.attempts,
    createdAt: input.now,
  });
}

export async function listUnresolvedJobs(db: DbOrTx, queue?: string, limit = 100) {
  const where = queue
    ? and(isNull(failedJobs.resolvedAt), eq(failedJobs.queue, queue))
    : isNull(failedJobs.resolvedAt);
  return db.select().from(failedJobs).where(where).orderBy(desc(failedJobs.id)).limit(limit);
}

export async function resolveFailedJob(db: DbOrTx, id: number, now: Date): Promise<number> {
  const result = await db
    .update(failedJobs)
    .set({ resolvedAt: now })
    .where(and(eq(failedJobs.id, id), isNull(failedJobs.resolvedAt)));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/** One page of the 失败的后台任务 screen, newest first. */
export async function pageFailedJobs(
  db: DbOrTx,
  input: { resolved: boolean; limit: number; offset: number },
) {
  const where = input.resolved ? isNotNull(failedJobs.resolvedAt) : isNull(failedJobs.resolvedAt);
  const rows = await db
    .select({
      id: failedJobs.id,
      jobName: failedJobs.jobName,
      error: failedJobs.error,
      errorSummary: failedJobs.errorSummary,
      attempts: failedJobs.attempts,
      createdAt: failedJobs.createdAt,
      resolvedAt: failedJobs.resolvedAt,
    })
    .from(failedJobs)
    .where(where)
    .orderBy(desc(failedJobs.id))
    .limit(input.limit)
    .offset(input.offset);
  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(failedJobs)
    .where(where);
  return { rows, total: count?.total ?? 0 };
}

export async function failedJobExists(db: DbOrTx, id: number): Promise<boolean> {
  const rows = await db
    .select({ id: failedJobs.id })
    .from(failedJobs)
    .where(eq(failedJobs.id, id))
    .limit(1);
  return rows.length > 0;
}

/** Failed jobs nobody has marked 已处理: the other half of 「异常待处理」. */
export async function countUnresolvedFailedJobs(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(failedJobs)
    .where(isNull(failedJobs.resolvedAt));
  return row?.n ?? 0;
}
