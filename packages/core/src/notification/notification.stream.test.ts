import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { subscribeToAdmin } from './notification.stream';

describe('notification stream Redis error handling', () => {
  it('attaches an error listener to the duplicated subscriber and forwards errors to onError', async () => {
    class FakeSubscriber extends EventEmitter {
      async subscribe(_channel: string): Promise<number> {
        return 1;
      }
      async unsubscribe(_channel: string): Promise<number> {
        return 0;
      }
      disconnect(): void {}
    }

    const subscriber = new FakeSubscriber();
    const fakeRedis = { duplicate: () => subscriber } as unknown as Redis;
    const seen: unknown[] = [];

    const unsubscribe = await subscribeToAdmin(fakeRedis, 1, () => undefined, {
      onError: (err) => seen.push(err),
    });

    expect(subscriber.listenerCount('error')).toBeGreaterThan(0);
    const blip = new Error('ECONNRESET');
    expect(() => subscriber.emit('error', blip)).not.toThrow();
    expect(seen).toEqual([blip]);

    await unsubscribe();
  });
});
