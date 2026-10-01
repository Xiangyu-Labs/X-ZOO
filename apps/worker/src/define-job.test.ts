import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob, indexJobs, JobPayloadError, parsePayload } from './define-job';
import { allJobs } from './jobs.gen';

const job = (over: Partial<Parameters<typeof defineJob>[0]> = {}) =>
  defineJob({
    name: 'order.autoCancel',
    schema: z.object({ orderId: z.string() }),
    handler: async () => {},
    ...over,
  } as never);

describe('defineJob', () => {
  it('accepts a well-formed definition', () => {
    const definition = job({ concurrency: 4, repeat: { every: 1000 } });
    expect(definition.name).toBe('order.autoCancel');
    expect(definition.concurrency).toBe(4);
  });

  it('insists on a <domain>.<verb> name', () => {
    for (const name of ['autoCancel', 'Order.autoCancel', 'order.auto_cancel', 'order.']) {
      expect(() => job({ name }), name).toThrow('<domain>.<verb>');
    }
  });

  it('rejects a nonsensical concurrency and an empty repeat spec', () => {
    expect(() => job({ concurrency: 0 })).toThrow('concurrency');
    expect(() => job({ repeat: {} })).toThrow('repeat');
  });

  it('accepts either a cron pattern or an interval', () => {
    expect(() => job({ repeat: { pattern: '0 3 * * *' } })).not.toThrow();
    expect(() => job({ repeat: { every: 5000 } })).not.toThrow();
  });
});

describe('parsePayload', () => {
  it('returns the parsed payload', () => {
    expect(parsePayload(job(), { orderId: '7' })).toEqual({ orderId: '7' });
  });

  it('throws a readable JobPayloadError for a stale payload shape', () => {
    // A job enqueued by an older deployment must fail loudly, not blow up
    // deep inside a service with "undefined is not an object".
    const error = (() => {
      try {
        parsePayload(job(), { order_id: 7 });
        return null;
      } catch (thrown) {
        return thrown as JobPayloadError;
      }
    })();
    expect(error).toBeInstanceOf(JobPayloadError);
    expect(error?.jobName).toBe('order.autoCancel');
    expect(error?.issues[0]?.field).toBe('orderId');
    expect(error?.message).toContain('order.autoCancel');
  });
});

describe('indexJobs', () => {
  it('indexes by name and skips disabled jobs', () => {
    const index = indexJobs([
      job(),
      job({ name: 'order.autoReceive' }),
      job({ name: 'order.disabled', disabled: true }),
    ]);
    expect([...index.keys()]).toEqual(['order.autoCancel', 'order.autoReceive']);
  });

  it('refuses two jobs with the same name', () => {
    expect(() => indexJobs([job(), job()])).toThrow('重复定义');
  });
});

describe('the generated job bucket', () => {
  it('picked up every file in src/jobs', () => {
    const names = allJobs.map((j) => j.name).sort();
    // Asserted structurally rather than as a literal list: every domain adds
    // jobs here, and a hard-coded list would make each of them edit this file.
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toEqual([...new Set(names)].sort());
    for (const name of names) expect(name, name).toMatch(/^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/);
    // The platform's own jobs must never disappear.
    expect(names).toEqual(
      expect.arrayContaining([
        'system.dispatchEffects',
        'system.heartbeat',
        'system.pruneSessions',
      ]),
    );
  });

  it('indexes cleanly — no duplicate names across the whole system', () => {
    expect(() => indexJobs(allJobs)).not.toThrow();
  });

  it('gives every scheduled job a valid repeat spec', () => {
    for (const definition of allJobs) {
      if (!definition.repeat) continue;
      expect(definition.repeat.pattern ?? definition.repeat.every, definition.name).toBeDefined();
    }
  });

  it('accepts an empty payload for every scheduled job', () => {
    // The scheduler enqueues `{}`; a schedule whose schema needs fields would
    // fail on every tick, forever.
    for (const definition of allJobs) {
      if (!definition.repeat) continue;
      expect(() => parsePayload(definition, {}), definition.name).not.toThrow();
    }
  });
});
