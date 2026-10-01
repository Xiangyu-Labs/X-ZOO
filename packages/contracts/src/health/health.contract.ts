import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import { instant } from '../_conventions/common';

/**
 * The smallest possible real domain, one route per surface. It exists so the
 * `pnpm gen` aggregation, the OpenAPI build, the example checker and the mock
 * server all have something to chew on from day one — and so the container
 * healthcheck has a documented endpoint instead of an undocumented one.
 */

export const healthPayload = z.object({
  status: z.literal('ok'),
  /** Server time, so a client can spot a badly skewed clock. */
  time: instant,
  /** Build/commit marker; `dev` outside CI. */
  version: z.string(),
});
export type HealthPayload = z.infer<typeof healthPayload>;

const example = {
  name: 'ok',
  response: { status: 'ok', time: '2026-01-01T12:00:00+08:00', version: 'dev' },
} as const;

export const storefrontHealth = defineRoute({
  id: 'health.storefront',
  method: 'GET',
  path: '/api/v1/health',
  auth: 'public',
  summary: '商城端健康检查',
  tags: ['health'],
  response: healthPayload,
  examples: [example],
});

export const adminHealth = defineRoute({
  id: 'health.admin',
  method: 'GET',
  path: '/admin-api/health',
  // Public on purpose: the container healthcheck must not need a session, and
  // `defineRoute` requires a permission for every `auth: 'admin'` route.
  auth: 'public',
  summary: '后台健康检查',
  tags: ['health'],
  response: healthPayload,
  examples: [example],
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const checkResult = z.enum(['ok', 'failed']);

export const readinessPayload = z.object({
  status: z.literal('ok'),
  time: instant,
  version: z.string(),
  /** One entry per dependency this process needs before it can serve. */
  checks: z.object({
    database: checkResult,
    redis: checkResult,
    /** The schema is at least as new as the one this build was compiled against. */
    migrations: checkResult,
    /**
     * The worker's loop heartbeat is fresh and it completed a job in the last
     * few minutes — a stack whose jobs are not running is not ready.
     */
    worker: checkResult,
  }),
  /**
   * Informational, **never** a failing check: what is queued behind a ready
   * stack. A backlog does not stop the stack serving, so it never fails
   * readiness. Absent when it could not be measured in time.
   */
  backlog: z
    .object({
      /**
       * How late the oldest post-commit effect still waiting for the
       * dispatcher is, in whole seconds; `null` when nothing is waiting. A
       * number that keeps growing means buyers' notifications are arriving
       * late.
       */
      effectsOldestDueSeconds: z.number().int().nonnegative().nullable(),
    })
    .optional(),
});
export type ReadinessPayload = z.infer<typeof readinessPayload>;

export const storefrontReadiness = defineRoute({
  id: 'health.readiness',
  method: 'GET',
  path: '/api/v1/readyz',
  // Public for the same reason `/api/v1/health` is: the caller is a probe and
  // has no session. It returns no data an attacker does not already have by
  // watching whether the site works.
  auth: 'public',
  summary: '就绪检查（深度）',
  tags: ['health'],
  response: readinessPayload,
  errors: ['HEALTH_NOT_READY'],
  // "Not ready yet" is this route's success case, not an incident. The
  // readiness gate polls it on every deploy, so at `error` a forty-second start
  // writes forty lines that describe nothing wrong — and buries the one that
  // does, in the window where somebody is deciding whether to roll back.
  expectedStatuses: [503],
  examples: [
    {
      name: 'ready',
      response: {
        status: 'ok',
        time: '2026-01-01T12:00:00+08:00',
        version: 'dev',
        checks: { database: 'ok', redis: 'ok', migrations: 'ok', worker: 'ok' },
        backlog: { effectsOldestDueSeconds: null },
      },
    },
  ],
});
