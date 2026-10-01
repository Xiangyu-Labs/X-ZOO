import { describe, expect, it } from 'vitest';
import {
  createAdminSessionStore,
  DEFAULT_ADMIN_SESSION_TTL_MS,
  REMEMBERED_ADMIN_SESSION_TTL_MS,
} from './admin-session.store';

/** Just enough of ioredis to see which lifetimes the store asks for. */
function recordingRedis() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const multi = () => {
    const chain = {
      set(key: string, value: string, _px: 'PX', ttl: number) {
        values.set(key, value);
        ttls.set(key, ttl);
        return chain;
      },
      sadd: () => chain,
      pexpire(key: string, ttl: number) {
        ttls.set(key, ttl);
        return chain;
      },
      exec: async () => [],
    };
    return chain;
  };
  const redis = {
    multi,
    get: async (key: string) => values.get(key) ?? null,
    eval: async (
      _lua: string,
      _keys: number,
      session: string,
      index: string,
      _member: string,
      sessionTtl: string,
      indexTtl: string,
    ) => {
      ttls.set(session, Number(sessionTtl));
      ttls.set(index, Number(indexTtl));
      return 1;
    },
  };
  return { redis: redis as never, ttls };
}

const session = {
  adminId: 3,
  account: 'op',
  name: '运营',
  avatar: null,
  isSuper: false,
  permissions: [],
  passwordVersion: 1,
};

describe('admin session lifetimes', () => {
  it('AUTH-011: a remembered session lives and slides seven days, a plain one eight hours', async () => {
    const { redis, ttls } = recordingRedis();
    const store = createAdminSessionStore({ redis });

    const plain = await store.create(session, 0);
    const kept = await store.create({ ...session, remember: true }, 0);
    const lifetimes = [...ttls.entries()]
      .filter(([key]) => !key.includes(':index:'))
      .map(([, ttl]) => ttl);
    expect(lifetimes.sort()).toEqual(
      [DEFAULT_ADMIN_SESSION_TTL_MS, REMEMBERED_ADMIN_SESSION_TTL_MS].sort(),
    );

    ttls.clear();
    expect(await store.resolve(kept)).toMatchObject({
      remember: true,
      ttlMs: REMEMBERED_ADMIN_SESSION_TTL_MS,
    });
    expect(await store.resolve(plain)).toMatchObject({ ttlMs: DEFAULT_ADMIN_SESSION_TTL_MS });
  });

  it('AUTH-011: the revoke index outlives a remembered session whichever session slid it last', async () => {
    const { redis, ttls } = recordingRedis();
    const store = createAdminSessionStore({ redis });
    const plain = await store.create(session, 0);
    await store.resolve(plain);
    expect(ttls.get('admin:sess:index:3')).toBeGreaterThan(REMEMBERED_ADMIN_SESSION_TTL_MS);
  });
});
