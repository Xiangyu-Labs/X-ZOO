import { z } from 'zod';
import { defineJob } from '../define-job';
import { JOB_HEARTBEAT_KEY, JOB_HEARTBEAT_TTL_MS } from '../job-heartbeat';

/**
 * A job that completes every minute, whatever else is queued.
 *
 * `worker:heartbeat:job` is written whenever *any* job completes
 * (`job-heartbeat.ts`), and `/api/v1/readyz` requires it to be recent. The
 * effects dispatcher alone would keep it fresh, but readiness should not rest
 * on one unrelated job staying scheduled; this one exists so the key has a
 * floor. It writes the key itself too, so the path is proven end to end:
 * scheduler, queue, payload validation, context, Redis.
 *
 * The container healthcheck reads the key the worker's main loop refreshes
 * (`worker:heartbeat`), not this one.
 */
export default defineJob({
  name: 'system.heartbeat',
  schema: z.object({}).default({}),
  concurrency: 1,
  repeat: { every: 60_000 },
  handler: async (ctx) => {
    await ctx.redis.set(JOB_HEARTBEAT_KEY, String(ctx.clock.nowMs()), 'PX', JOB_HEARTBEAT_TTL_MS);
    ctx.logger.debug('heartbeat');
  },
});
