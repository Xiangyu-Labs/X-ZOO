import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixedClock, systemClock } from './clock';
import { DomainError, forbidden, notFound, resolveError } from './errors';
import {
  fromId,
  generateOrderNo,
  generateOutTradeNo,
  randomToken,
  timePrefix,
  toId,
  toIdOrNull,
} from './ids';
import { redactedKeys, silentLogger } from './logger';
import { memoryQueue, noopQueue } from './queue';
import {
  buildStorageKey,
  createLocalStorage,
  memoryStorage,
  safeExtension,
  sanitiseDirectory,
} from './storage';
import { anonymousActor, createCtx, requireAdminId, requireUserId, systemActor } from './context';
import { backoffMs } from '../effects';

describe('Clock', () => {
  it('fixedClock stands still until a test moves it', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    expect(clock.nowMs()).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
    clock.set('2027-06-01T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-06-01T12:00:00.000Z');
  });

  it('rejects an unparseable time', () => {
    expect(() => fixedClock('not a date')).toThrow(TypeError);
    expect(() => fixedClock().set('nope')).toThrow(TypeError);
  });

  it('systemClock agrees with itself', () => {
    expect(Math.abs(systemClock.now().getTime() - systemClock.nowMs())).toBeLessThan(50);
  });
});

describe('DomainError', () => {
  it('takes status and message from the contracts registry', () => {
    const error = new DomainError('AUTH_INVALID_CREDENTIALS');
    expect(error.status).toBe(401);
    expect(error.message).toBe('账号或密码不正确');
    expect(error.unregistered).toBe(false);
    expect(error.toBody()).toEqual({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '账号或密码不正确',
    });
  });

  it('carries details when given, and omits the key when not', () => {
    const withDetails = new DomainError('VALIDATION_FAILED', { details: [{ field: 'a' }] });
    expect(withDetails.toBody().details).toEqual([{ field: 'a' }]);
    expect('details' in notFound().toBody()).toBe(false);
  });

  it('degrades to a 500 for a code nobody declared', () => {
    const error = new DomainError('NOT_A_REAL_CODE');
    expect(error.status).toBe(500);
    expect(error.unregistered).toBe(true);
    expect(resolveError('NOT_A_REAL_CODE').status).toBe(500);
  });

  it('is recognisable across the module boundary', () => {
    expect(DomainError.is(forbidden())).toBe(true);
    expect(DomainError.is(new Error('x'))).toBe(false);
  });
});

describe('ids', () => {
  it('converts between the DB number and the wire string', () => {
    expect(toId(42)).toBe('42');
    expect(fromId('42')).toBe(42);
    expect(toIdOrNull(null)).toBeNull();
    expect(toIdOrNull(7)).toBe('7');
  });

  it('refuses ids that would silently corrupt', () => {
    expect(() => toId(0)).toThrow(TypeError);
    expect(() => toId(-1)).toThrow(TypeError);
    expect(() => toId(1.5)).toThrow(TypeError);
    for (const bad of ['', '0', '01', 'x', '-1', '1.0', '9007199254740993']) {
      expect(() => fromId(bad), bad).toThrow(TypeError);
    }
  });
});

describe('order numbers', () => {
  const clock = fixedClock('2026-02-03T04:05:06.000Z');

  it('is time-prefixed in Asia/Shanghai and 24 digits long', () => {
    const no = generateOrderNo(clock);
    expect(no).toMatch(/^\d{24}$/);
    // 04:05:06Z is 12:05:06 in Shanghai.
    expect(no.slice(0, 14)).toBe('20260203120506');
  });

  it('sorts by creation time', () => {
    const early = generateOrderNo(fixedClock('2026-01-01T00:00:00Z'));
    const late = generateOrderNo(fixedClock('2026-12-31T00:00:00Z'));
    expect(early < late).toBe(true);
  });

  it('does not collide across ten thousand draws in the same second', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(generateOrderNo(clock));
    expect(seen.size).toBe(10_000);
  });

  it('keeps payment numbers in a separate namespace', () => {
    expect(generateOutTradeNo(clock).startsWith('P')).toBe(true);
    expect(generateOrderNo(clock, { prefix: 'R' }).startsWith('R')).toBe(true);
  });

  it('handles midnight, where some ICU builds report hour 24', () => {
    expect(timePrefix(new Date('2026-02-02T16:00:00Z')).slice(8, 10)).toBe('00');
  });
});

describe('randomToken', () => {
  it('is url-safe, of the requested length, and not repeated', () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => randomToken(32)));
    expect(tokens.size).toBe(2000);
    for (const token of tokens) expect(token).toMatch(/^[a-z2-9]{32}$/);
  });
});

describe('logger', () => {
  it('redacts every credential-shaped key', () => {
    for (const key of ['password', 'token', 'authorization', 'apiV3Key', 'cookie']) {
      expect(redactedKeys).toContain(key);
    }
  });

  it('silentLogger writes nothing', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    silentLogger().error({ password: 'hunter2' }, 'boom');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('queue port', () => {
  it('records what was enqueued', async () => {
    const queue = memoryQueue();
    await queue.enqueue('order.autoCancel', { orderId: 1 }, { delay: 1000 });
    expect(queue.jobs).toEqual([
      { jobName: 'order.autoCancel', payload: { orderId: 1 }, options: { delay: 1000 } },
    ]);
    queue.reset();
    expect(queue.jobs).toHaveLength(0);
  });

  it('collapses duplicates by dedupeKey and can cancel one', async () => {
    const queue = memoryQueue();
    await queue.enqueue('a', {}, { dedupeKey: 'order:1:cancel' });
    await queue.enqueue('a', {}, { dedupeKey: 'order:1:cancel' });
    expect(queue.jobs).toHaveLength(1);
    await queue.cancel('order:1:cancel');
    expect(queue.jobs).toHaveLength(0);
  });

  it('noopQueue drops silently', async () => {
    await expect(noopQueue.enqueue('x', {})).resolves.toBeUndefined();
  });
});

describe('storage keys are generated by the server, never by the client', () => {
  it('sanitises the directory hint', () => {
    expect(sanitiseDirectory('../../etc')).toBe('etc');
    expect(sanitiseDirectory('Product Images!')).toBe('productimages');
    expect(sanitiseDirectory(undefined)).toBe('misc');
    expect(sanitiseDirectory('!!!')).toBe('misc');
  });

  it('only honours whitelisted extensions', () => {
    expect(safeExtension('a.PNG')).toBe('png');
    expect(safeExtension('shell.php')).toBe('bin');
    expect(safeExtension('x.php.jpg')).toBe('jpg');
    expect(safeExtension(undefined)).toBe('bin');
    expect(safeExtension('noextension')).toBe('bin');
  });

  it('never lets a client-supplied name reach the key', () => {
    const key = buildStorageKey(new Date('2026-02-01T00:00:00Z'), {
      directory: '../../../etc',
      filename: '../../evil.php',
    });
    expect(key).toMatch(/^etc\/2026\/02\/[0-9a-f]{32}\.bin$/);
  });

  it('refuses to read or write outside the root', async () => {
    const storage = createLocalStorage({ root: '/tmp/shop-test-uploads' });
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', '']) {
      await expect(storage.get(bad), bad).rejects.toThrow('非法的存储 key');
    }
  });

  it('writes a thumbnail only next to a key it generated', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'shop-variants-'));
    try {
      const storage = createLocalStorage({ root, now: () => new Date('2026-02-01T00:00:00Z') });
      const stored = await storage.put(Buffer.from('jpeg'), {
        directory: 'product',
        filename: 'a.jpg',
      });
      const key = await storage.putVariant(stored.key, 960, Buffer.from('small'), 'image/jpeg');
      expect(key).toBe(stored.key.replace(/\.jpg$/, '.w960.jpg'));
      expect((await storage.get(key)).toString()).toBe('small');
      expect(storage.url(key)).toBe(`/uploads/${key}`);

      for (const bad of ['../etc/passwd.jpg', 'product/2026/02/x.jpg', `${key}`]) {
        await expect(
          storage.putVariant(bad, 480, Buffer.from('x'), 'image/jpeg'),
          bad,
        ).rejects.toThrow();
      }
      const gif = await storage.put(Buffer.from('gif'), {
        directory: 'product',
        filename: 'a.gif',
      });
      await expect(
        storage.putVariant(gif.key, 480, Buffer.from('x'), 'image/gif'),
      ).rejects.toThrow();

      const memory = memoryStorage(() => new Date('2026-02-01T00:00:00Z'));
      const inMemory = await memory.put(Buffer.from('png'), {
        directory: 'review',
        filename: 'b.png',
      });
      const variant = await memory.putVariant(inMemory.key, 480, Buffer.from('s'), 'image/png');
      expect(await memory.exists(variant)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('memoryStorage behaves like the local driver', async () => {
    const storage = memoryStorage(() => new Date('2026-02-01T00:00:00Z'));
    const stored = await storage.put(Buffer.from('hello'), { directory: 'diy', filename: 'a.png' });
    expect(stored.size).toBe(5);
    expect(stored.contentType).toBe('image/png');
    expect(stored.sha256).toHaveLength(64);
    expect(await storage.exists(stored.key)).toBe(true);
    expect(storage.url(stored.key)).toBe(`/uploads/${stored.key}`);
    expect((await storage.get(stored.key)).toString()).toBe('hello');
    await storage.delete(stored.key);
    expect(await storage.exists(stored.key)).toBe(false);
  });
});

describe('Ctx', () => {
  const base = {
    db: {} as never,
    redis: {} as never,
    clock: fixedClock(),
    config: {} as never,
    logger: silentLogger(),
    queue: memoryQueue(),
    storage: memoryStorage(),
    platform: null,
    requestId: 'req-1',
  };

  it('requireUserId / requireAdminId gate on the actor kind', () => {
    const anon = createCtx({ ...base, actor: anonymousActor });
    expect(() => requireUserId(anon)).toThrow(DomainError);
    expect(() => requireAdminId(anon)).toThrow(DomainError);

    const admin = createCtx({
      ...base,
      actor: { kind: 'admin', id: 9, permissions: [], isSuper: true },
    });
    expect(requireAdminId(admin)).toBe(9);
    expect(() => requireUserId(admin)).toThrow(DomainError);

    const user = createCtx({
      ...base,
      actor: { kind: 'user', id: 3, permissions: [], isSuper: false },
    });
    expect(requireUserId(user)).toBe(3);
  });

  it('as() swaps the actor and keeps everything else', () => {
    const ctx = createCtx({ ...base, actor: anonymousActor });
    const asSystem = ctx.as(systemActor);
    expect(asSystem.actor.kind).toBe('system');
    expect(asSystem.requestId).toBe('req-1');
    expect(typeof asSystem.withTx).toBe('function');
  });
});

describe('effects backoff', () => {
  it('doubles from the base and stops at the cap', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(3)).toBe(20_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
    expect(backoffMs(1, { baseBackoffMs: 100, maxBackoffMs: 250 })).toBe(100);
    expect(backoffMs(3, { baseBackoffMs: 100, maxBackoffMs: 250 })).toBe(250);
  });
});
