import type { Ctx } from '@shop/core/kernel';
import type { z } from 'zod';

/**
 * A job is declared next to its domain (`src/jobs/<domain>.<what>.ts`) and
 * picked up by `pnpm gen`, exactly like a contract or a permission atom. No
 * shared registry file to edit, so domains add jobs without conflicting.
 *
 *     export default defineJob({
 *       name: 'order.autoCancel',
 *       schema: z.object({ orderId: z.string() }),
 *       concurrency: 4,
 *       handler: (ctx, payload) => orderService.autoCancel(ctx, payload),
 *     });
 *
 * The payload is validated before the handler runs: a job enqueued by an old
 * deployment with a shape this one no longer understands fails loudly with a
 * readable error instead of throwing `undefined is not an object` deep inside
 * a service.
 */

export interface RepeatSpec {
  /** Standard 5-field cron, in the container's timezone (Asia/Shanghai). */
  pattern?: string;
  /** Or a plain interval in milliseconds. */
  every?: number;
}

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  /** `<domain>.<verb>`, globally unique. Becomes the BullMQ job name. */
  name: string;
  schema: S;
  handler: (ctx: Ctx, payload: z.output<S>) => Promise<void>;
  /** How many of this job may run at once in one worker process. */
  concurrency?: number;
  /** Attempts before the job lands in `failed_jobs`. */
  attempts?: number;
  /** Present for a scheduled job; absent for one that is enqueued on demand. */
  repeat?: RepeatSpec;
  /** Skip registration without deleting the file. */
  disabled?: boolean;
}

export type AnyJobDefinition = JobDefinition<z.ZodType>;

const NAME = /^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/;

export function defineJob<S extends z.ZodType>(definition: JobDefinition<S>): JobDefinition<S> {
  if (!NAME.test(definition.name)) {
    throw new Error(`job "${definition.name}" 必须是 <domain>.<verb> 形式`);
  }
  if (definition.concurrency !== undefined && definition.concurrency < 1) {
    throw new Error(`job "${definition.name}": concurrency 必须 >= 1`);
  }
  if (definition.repeat && !definition.repeat.pattern && !definition.repeat.every) {
    throw new Error(`job "${definition.name}": repeat 需要 pattern 或 every`);
  }
  return definition;
}

/** Thrown when a queued payload does not match the job's current schema. */
export class JobPayloadError extends Error {
  constructor(
    readonly jobName: string,
    readonly issues: Array<{ field: string; message: string }>,
  ) {
    super(`job ${jobName}: 载荷校验失败 ${JSON.stringify(issues)}`);
    this.name = 'JobPayloadError';
  }
}

export function parsePayload<S extends z.ZodType>(
  definition: JobDefinition<S>,
  raw: unknown,
): z.output<S> {
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw new JobPayloadError(
      definition.name,
      parsed.error.issues.map((issue) => ({
        field: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/** Builds the name -> definition index the worker dispatches through. */
export function indexJobs(jobs: readonly AnyJobDefinition[]): Map<string, AnyJobDefinition> {
  const index = new Map<string, AnyJobDefinition>();
  for (const job of jobs) {
    if (job.disabled) continue;
    if (index.has(job.name)) throw new Error(`job "${job.name}" 重复定义`);
    index.set(job.name, job);
  }
  return index;
}
