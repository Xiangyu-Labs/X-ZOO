import { describe, expect, it } from 'vitest';
import { createKeyedGate } from './job-gate';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createKeyedGate', () => {
  it('serialises tasks sharing a key when limit is 1', async () => {
    const gate = createKeyedGate();
    const first = deferred();
    const order: string[] = [];
    let peak = 0;

    const p1 = gate.run('storage.generateImageVariants', 1, async () => {
      peak = Math.max(peak, gate.activeCount('storage.generateImageVariants'));
      order.push('start-1');
      await first.promise;
      order.push('end-1');
    });
    const p2 = gate.run('storage.generateImageVariants', 1, async () => {
      peak = Math.max(peak, gate.activeCount('storage.generateImageVariants'));
      order.push('start-2');
      order.push('end-2');
    });

    await Promise.resolve();
    expect(order).toEqual(['start-1']);
    expect(gate.activeCount('storage.generateImageVariants')).toBe(1);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(peak).toBe(1);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(gate.activeCount('storage.generateImageVariants')).toBe(0);
  });

  it('does not let a third task jump ahead when one slot hands off to a waiter', async () => {
    const gate = createKeyedGate();
    const first = deferred();
    const second = deferred();
    const started: number[] = [];

    const p1 = gate.run('job', 1, async () => {
      started.push(1);
      await first.promise;
    });
    const p2 = gate.run('job', 1, async () => {
      started.push(2);
      await second.promise;
    });
    const p3 = gate.run('job', 1, async () => {
      started.push(3);
    });

    first.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([1, 2]);
    expect(gate.activeCount('job')).toBe(1);

    second.resolve();
    await Promise.all([p1, p2, p3]);
    expect(started).toEqual([1, 2, 3]);
    expect(gate.activeCount('job')).toBe(0);
  });

  it('runs different keys concurrently and up to `limit` within one key', async () => {
    const gate = createKeyedGate();
    const blockers = [deferred(), deferred(), deferred()];
    const activeOrder: number[] = [];

    const p1 = gate.run('order.autoCancel', 2, async () => {
      activeOrder.push(1);
      await blockers[0]!.promise;
    });
    const p2 = gate.run('order.autoCancel', 2, async () => {
      activeOrder.push(2);
      await blockers[1]!.promise;
    });
    const p3 = gate.run('order.autoCancel', 2, async () => {
      activeOrder.push(3);
    });
    const other = gate.run('system.dispatchEffects', 1, async () => {
      activeOrder.push(99);
      await blockers[2]!.promise;
    });

    await Promise.resolve();
    expect(activeOrder).toEqual([1, 2, 99]);
    expect(gate.activeCount('order.autoCancel')).toBe(2);
    expect(gate.activeCount('system.dispatchEffects')).toBe(1);

    blockers.forEach((b) => b.resolve());
    await Promise.all([p1, p2, p3, other]);
    expect(activeOrder).toEqual([1, 2, 99, 3]);
  });

  it('releases the slot and wakes the next waiter when a task rejects', async () => {
    const gate = createKeyedGate();
    const p1 = gate.run('job', 1, async () => {
      throw new Error('boom');
    });
    const p2 = gate.run('job', 1, async () => 'ok');

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    expect(gate.activeCount('job')).toBe(0);
  });
});
