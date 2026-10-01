import { z } from 'zod';
import { dispatchDueEffects } from '@shop/core/effects';
import { defineJob } from '../define-job';

/**
 * The effects dispatcher, as a repeatable job.
 *
 * Every post-commit side effect in the system — notify WeChat, send an SMS,
 * push a subscription message — is delivered from here. It runs every five
 * seconds rather than in a tight loop so that one slow handler cannot starve
 * the queue, and `concurrency: 1` per process keeps the claim pattern honest;
 * horizontal scale comes from running more worker containers, which
 * `FOR UPDATE SKIP LOCKED` already handles.
 *
 * A run claims a batch, and keeps claiming while each batch comes back full,
 * for at most `budgetMs`. One batch per tick capped a worker at
 * 10 effects/s however long the queue was — about 1.7 paid orders/s — and the
 * load smoke left thousands pending. The budget stays under the 5 s repeat,
 * so a run always returns and a redeploy never waits on an unbounded drain.
 *
 * The log line carries `oldestDueAgeMs`: how late the oldest effect still
 * waiting is after the run. `/api/v1/readyz` reports the same number as a
 * detail, so a growing backlog is visible before a customer notices it.
 */
export default defineJob({
  name: 'system.dispatchEffects',
  schema: z
    .object({
      batchSize: z.number().int().min(1).max(200).default(50),
      budgetMs: z.number().int().min(0).max(4_500).default(4_000),
    })
    .prefault({}),
  concurrency: 1,
  attempts: 1, // the ledger has its own retry policy; a BullMQ retry would double it
  repeat: { every: 5_000 },
  handler: async (ctx, payload) => {
    const report = await dispatchDueEffects(ctx, {
      batchSize: payload.batchSize,
      budgetMs: payload.budgetMs,
    });
    if (report.claimed > 0 || report.oldestDueAgeMs !== null) {
      ctx.logger.info(report, 'effects dispatched');
    }
    if (report.parked > 0) {
      ctx.logger.error({ parked: report.parked }, 'effects parked as unknown — needs a human');
    }
  },
});
