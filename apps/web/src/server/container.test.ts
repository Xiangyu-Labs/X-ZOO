import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSmsSenderOverride, resetSmsSender } from '@shop/core/sms';
import { createDb } from '@shop/db';
import { applyProcessOverrides, resetProcessOverrides, webDbOptions } from './container';
import type { Env } from './env';

/**
 * `SHOP_FAKE_SMS=1` at boot: what `buildContainer()` does with it,
 * without a database. The HTTP half — a code really lands in Redis — is
 * `fake-sms.int.test.ts`.
 */

const env: Env = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://unused',
  REDIS_URL: 'redis://unused',
  UPLOADS_DIR: '/tmp/uploads',
  UPLOADS_PUBLIC_PREFIX: '/uploads',
  APP_ORIGIN: 'https://shop.example',
  EXTRA_ALLOWED_ORIGINS: [],
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  VALIDATE_RESPONSES: false,
  DB_POOL_MAX: 5,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

afterEach(() => {
  resetSmsSender();
  resetProcessOverrides();
});

describe('applyProcessOverrides', () => {
  it("registers the fake SMS sender when SHOP_FAKE_SMS is '1', and says so once", () => {
    const logger = { warn: vi.fn() };

    applyProcessOverrides({ ...env, SHOP_FAKE_SMS: '1' }, logger);
    expect(getSmsSenderOverride()?.name).toBe('fake');

    // A second container in the same process (a hot reload) does not repeat it.
    applyProcessOverrides({ ...env, SHOP_FAKE_SMS: '1' }, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { env: 'SHOP_FAKE_SMS' },
      'fake SMS sender active — codes are not delivered',
    );
  });

  it("leaves the configured provider alone when unset, empty or '0'", () => {
    const logger = { warn: vi.fn() };
    applyProcessOverrides(env, logger);
    applyProcessOverrides({ ...env, SHOP_FAKE_SMS: '' }, logger);
    applyProcessOverrides({ ...env, SHOP_FAKE_SMS: '0' }, logger);
    expect(getSmsSenderOverride()).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('webDbOptions', () => {
  it('logs a connection the server ends outside a query, as the worker does', () => {
    const logger = { warn: vi.fn() };
    // `pg.Pool` connects lazily, so a pool on an unreachable URL is fine here.
    const handle = createDb('postgres://unused@127.0.0.1:9/none', webDbOptions(env, logger));
    try {
      expect(webDbOptions(env, logger).max).toBe(env.DB_POOL_MAX);
      const error = new Error('terminating connection due to idle-in-transaction timeout');
      handle.pool.emit('error', error);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: error },
        'database connection ended outside a query',
      );
    } finally {
      void handle.close();
    }
  });
});
