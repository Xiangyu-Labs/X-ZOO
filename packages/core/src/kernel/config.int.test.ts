import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configValues } from '@shop/db/schema/system';
import { createDb } from '@shop/db';
import { createTestCtx, type TestCtx } from '@shop/testing';
import {
  createConfigService,
  defineConfigGroup,
  getConfigGroup,
  pruneUnknownKeys,
  resetConfigRegistry,
  type ConfigService,
} from './config-registry';
import { type DomainError } from './errors';

let harness: TestCtx;
let config: ConfigService;

const paymentConfig = defineConfigGroup({
  group: 'payment',
  title: '支付设置',
  schema: z.object({
    wechatEnabled: z.boolean().default(false),
    wechatMchId: z.string().default(''),
    autoCancelMinutes: z.number().int().min(1).max(1440).default(30),
    notifyUrls: z.array(z.string()).default([]),
  }),
  ui: {
    wechatEnabled: { label: '启用微信支付', type: 'switch' },
    wechatMchId: { label: '商户号', type: 'text' },
    autoCancelMinutes: { label: '未支付自动取消（分钟）', type: 'number' },
    notifyUrls: { label: '回调地址', type: 'json' },
  },
  permission: 'system:config:update',
});

beforeAll(async () => {
  harness = await createTestCtx();
  config = harness.ctx.config;
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
});

describe('defineConfigGroup', () => {
  it('registers the group so the generic admin screen can find it', () => {
    expect(getConfigGroup('payment')).toBe(paymentConfig);
  });

  it('refuses a group whose fields are not all defaulted', () => {
    // A fresh install has no rows; a field without a default makes the shop
    // unreadable before anybody has saved anything.
    expect(() =>
      defineConfigGroup({
        group: 'broken',
        title: 'x',
        schema: z.object({ required: z.string() }),
        ui: {},
      }),
    ).toThrow('必须有 .default()');
  });

  it('refuses a badly named group and a duplicate registration', () => {
    expect(() =>
      defineConfigGroup({ group: 'Payment', title: 'x', schema: z.object({}), ui: {} }),
    ).toThrow('小写短横线');
    expect(() =>
      defineConfigGroup({ group: 'payment', title: 'x', schema: z.object({}), ui: {} }),
    ).toThrow('重复定义');
  });

  it('refuses a visibleWhen that does not name a field of the same group', () => {
    // A typo here hides the field for ever with no error anywhere, which is the
    // failure mode the registry exists to prevent — so it throws at declaration.
    expect(() =>
      defineConfigGroup({
        group: 'bad-visible-when',
        title: 'x',
        schema: z.object({ driver: z.string().default('local'), bucket: z.string().default('') }),
        ui: {
          driver: { label: '驱动', type: 'text' },
          bucket: { label: 'Bucket', type: 'text', visibleWhen: { key: 'drivre', equals: 's3' } },
        },
      }),
    ).toThrow('不是本分组的字段');

    expect(() =>
      defineConfigGroup({
        group: 'self-visible-when',
        title: 'x',
        schema: z.object({ driver: z.string().default('local') }),
        ui: {
          driver: { label: '驱动', type: 'text', visibleWhen: { key: 'driver', equals: 's3' } },
        },
      }),
    ).toThrow('不能指向自己');
  });
});

describe('config.get', () => {
  it('returns schema defaults when nothing has ever been saved', async () => {
    expect(await config.get(paymentConfig)).toEqual({
      wechatEnabled: false,
      wechatMchId: '',
      autoCancelMinutes: 30,
      notifyUrls: [],
    });
  });

  it('is typed: values come back as the types the schema declares', async () => {
    await config.set(paymentConfig, { wechatEnabled: true, autoCancelMinutes: 15 });
    const values = await config.get(paymentConfig);
    expect(values.wechatEnabled).toBe(true);
    expect(values.autoCancelMinutes).toBe(15);
    // jsonb keeps a boolean a boolean, not the string "1".
    const rows = await harness.ctx.db.select().from(configValues);
    expect(rows.find((r) => r.key === 'wechatEnabled')?.value).toBe(true);
  });

  it('falls back to the default for a stored value the schema no longer accepts', async () => {
    await harness.ctx.db.insert(configValues).values({
      group: 'payment',
      key: 'autoCancelMinutes',
      value: 'thirty' as never,
    });
    const values = await config.get(paymentConfig);
    expect(values.autoCancelMinutes).toBe(30);
  });
});

describe('strings that look like JSON', () => {
  // If node-postgres parsed jsonb and drizzle then parsed any string again, an
  // all-digit merchant id would come back as a number and fall to its default.
  it.each(['1900000001', 'true', 'null', '{"a":1}', '013800138000', 'abc'])(
    'reads %j back as the string that was saved',
    async (value) => {
      await config.set(paymentConfig, { wechatMchId: value });
      config.invalidate?.('payment');
      const raw = await harness.ctx.db.select({ value: configValues.value }).from(configValues);
      expect(raw.map((row) => row.value)).toContain(value);
      expect((await config.get(paymentConfig)).wechatMchId).toBe(value);
    },
  );

  it('still reads objects and arrays as values, parsed once', async () => {
    await config.set(paymentConfig, { notifyUrls: ['https://a.example', '42'] });
    expect((await config.get(paymentConfig)).notifyUrls).toEqual(['https://a.example', '42']);
  });
});

describe('config.set', () => {
  it('writes only the keys that actually changed', async () => {
    await config.set(paymentConfig, { wechatEnabled: true });
    expect(await harness.ctx.db.select().from(configValues)).toHaveLength(1);

    await config.set(paymentConfig, { wechatEnabled: true, wechatMchId: '1900000001' });
    const rows = await harness.ctx.db.select().from(configValues);
    expect(rows.map((r) => r.key).sort()).toEqual(['wechatEnabled', 'wechatMchId']);
  });

  it('records who changed it', async () => {
    await config.set(paymentConfig, { wechatMchId: '1900000001' }, { updatedBy: 42 });
    const [row] = await harness.ctx.db.select().from(configValues);
    expect(row?.updatedBy).toBe(42);
    expect(row?.updatedAt.getTime()).toBe(harness.clock.nowMs());
  });

  it('validates the whole group and refuses a bad value with field details', async () => {
    const error = await config
      .set(paymentConfig, { autoCancelMinutes: 99_999 })
      .catch((e: DomainError) => e);
    expect((error as DomainError).code).toBe('VALIDATION_FAILED');
    expect((error as DomainError).details).toEqual([
      { field: 'autoCancelMinutes', message: expect.any(String) },
    ]);
    // Nothing was written.
    expect(await harness.ctx.db.select().from(configValues)).toHaveLength(0);
  });

  it('updates an existing key rather than inserting a duplicate', async () => {
    await config.set(paymentConfig, { wechatMchId: 'a' });
    await config.set(paymentConfig, { wechatMchId: 'b' });
    const rows = await harness.ctx.db.select().from(configValues);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('b');
  });
});

describe('the Redis cache', () => {
  it('serves the second read from Redis', async () => {
    await config.set(paymentConfig, { wechatMchId: '1900000001' });
    await config.get(paymentConfig);
    expect(await harness.redis.get('config:payment')).toContain('1900000001');
  });

  it('is invalidated on write, so a later read sees the new value', async () => {
    await config.get(paymentConfig);
    expect(await harness.redis.get('config:payment')).toBe('{}');

    await config.set(paymentConfig, { autoCancelMinutes: 5 });
    expect(await harness.redis.get('config:payment')).toBeNull();
    expect((await config.get(paymentConfig)).autoCancelMinutes).toBe(5);
  });

  it('a second process sees the write, because the cache key is shared', async () => {
    const other = createConfigService({
      db: harness.ctx.db,
      cache: {
        get: (key) => harness.redis.get(key),
        set: (key, value, _mode, ttl) => harness.redis.set(key, value, 'PX', ttl),
        del: (...keys) => harness.redis.del(...keys),
      },
      clock: harness.clock,
    });

    await other.get(paymentConfig); // warms the shared cache
    await config.set(paymentConfig, { wechatMchId: 'from-process-one' });
    expect((await other.get(paymentConfig)).wechatMchId).toBe('from-process-one');
  });

  it('survives a corrupt cache entry instead of failing every request', async () => {
    await harness.redis.set('config:payment', 'not json');
    expect(await config.get(paymentConfig)).toMatchObject({ autoCancelMinutes: 30 });
  });

  it('invalidate() drops the entry by hand', async () => {
    await config.get(paymentConfig);
    await config.invalidate('payment');
    expect(await harness.redis.get('config:payment')).toBeNull();
  });

  it('getRaw returns what is stored, for the generic admin form', async () => {
    await config.set(paymentConfig, { wechatMchId: 'x' });
    expect(await config.getRaw('payment')).toEqual({ wechatMchId: 'x' });
    expect(await config.getRaw('nothing-here')).toEqual({});
  });
});

describe('config.getIn — a read inside a transaction', () => {
  it('sees the transaction’s own uncommitted rows, which a pooled read cannot', async () => {
    let inside: number | undefined;
    let pooled: number | undefined;
    await harness.ctx
      .withTx(async (tx) => {
        await tx
          .insert(configValues)
          .values({ group: 'payment', key: 'autoCancelMinutes', value: 7 });
        inside = (await config.getIn(tx, paymentConfig)).autoCancelMinutes;
        pooled = (await config.get(paymentConfig)).autoCancelMinutes;
        throw new Error('roll back');
      })
      .catch(() => undefined);
    expect(inside).toBe(7);
    expect(pooled).toBe(30);
    // The miss did not fill the cache from a transaction that then rolled back:
    // the pooled `get` above filled it, from committed rows.
    expect(await harness.redis.get('config:payment')).toBe('{}');
  });

  it('serves a hit from the cache, the same as get', async () => {
    await config.set(paymentConfig, { wechatMchId: 'cached' });
    await config.get(paymentConfig);
    await harness.ctx.db.update(configValues).set({ value: 'changed-underneath' as never });
    const values = await harness.ctx.withTx((tx) => config.getIn(tx, paymentConfig));
    expect(values.wechatMchId).toBe('cached');
  });

  it('is exactly get when it is handed the pool rather than a transaction', async () => {
    await config.set(paymentConfig, { autoCancelMinutes: 9 });
    expect((await config.getIn(harness.ctx.db, paymentConfig)).autoCancelMinutes).toBe(9);
    // …and, like get, fills the cache from committed rows.
    expect(await harness.redis.get('config:payment')).toContain('"autoCancelMinutes":9');
  });

  it('never asks the pool for a second connection: it finishes on a pool of one', async () => {
    const single = createDb(harness.db.url, { max: 1 });
    try {
      const service = createConfigService({
        db: single.db,
        cache: {
          get: (key) => harness.redis.get(key),
          set: (key, value, _mode, ttl) => harness.redis.set(key, value, 'PX', ttl),
          del: (...keys) => harness.redis.del(...keys),
        },
        clock: harness.clock,
      });
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        single.db
          .transaction(async (tx) => (await service.getIn(tx, paymentConfig)).autoCancelMinutes)
          .then((minutes) => ({ minutes })),
        new Promise<'starved'>((resolve) => {
          timer = setTimeout(() => resolve('starved'), 5_000);
        }),
      ]);
      clearTimeout(timer);
      expect(outcome).toEqual({ minutes: 30 });
    } finally {
      await single.close();
    }
  });
});

describe('pruneUnknownKeys', () => {
  it('removes keys the schema no longer declares and reports them', async () => {
    await harness.ctx.db.insert(configValues).values([
      { group: 'payment', key: 'wechatMchId', value: 'keep' as never },
      { group: 'payment', key: 'alipayAppId', value: 'drop' as never },
    ]);
    expect(await pruneUnknownKeys(harness.ctx.db, paymentConfig)).toEqual(['alipayAppId']);
    const rows = await harness.ctx.db.select().from(configValues);
    expect(rows.map((r) => r.key)).toEqual(['wechatMchId']);
  });
});

describe('registry hygiene', () => {
  it('resetConfigRegistry is available to tests that need a clean slate', () => {
    resetConfigRegistry();
    expect(getConfigGroup('payment')).toBeUndefined();
    // Put it back for any test that runs after this one in the same file.
    defineConfigGroup(paymentConfig);
    expect(getConfigGroup('payment')).toBeDefined();
  });
});
