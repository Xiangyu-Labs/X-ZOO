import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob, type AnyJobDefinition } from './define-job';
import { planEnqueue } from './enqueue';

const jobs = [
  defineJob({
    name: 'storage.backfillImageVariants',
    schema: z.object({ limit: z.number().int().min(1).default(50) }).prefault({}),
    handler: async () => {},
  }),
  defineJob({
    name: 'storage.cleanOrphans',
    schema: z.object({}),
    repeat: { pattern: '40 3 * * *' },
    handler: async () => {},
  }),
] as AnyJobDefinition[];

describe('planEnqueue', () => {
  it('takes an on-demand job with no payload, or a valid JSON one', () => {
    expect(planEnqueue(['storage.backfillImageVariants'], jobs)).toEqual({
      ok: true,
      jobName: 'storage.backfillImageVariants',
      payload: {},
    });
    expect(planEnqueue(['storage.backfillImageVariants', '{"limit":20}'], jobs)).toEqual({
      ok: true,
      jobName: 'storage.backfillImageVariants',
      payload: { limit: 20 },
    });
  });

  it('refuses an unknown job, a scheduled one, bad JSON and a payload the schema rejects', () => {
    const refused = (args: string[]) => {
      const plan = planEnqueue(args, jobs);
      expect(plan.ok, args.join(' ')).toBe(false);
      return plan.ok ? '' : plan.message;
    };
    expect(refused([])).toContain('storage.backfillImageVariants');
    expect(refused([])).not.toContain('storage.cleanOrphans');
    expect(refused(['order.nope'])).toContain('没有任务');
    expect(refused(['storage.cleanOrphans'])).toContain('定时任务');
    expect(refused(['storage.backfillImageVariants', '{limit:'])).toContain('JSON');
    expect(refused(['storage.backfillImageVariants', '{"limit":0}'])).toContain('载荷校验失败');
    expect(refused(['storage.backfillImageVariants', '{}', 'extra'])).toContain('用法');
  });
});
