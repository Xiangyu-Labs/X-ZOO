import { beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../kernel/clock';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { memoryStorage, type Storage } from '../kernel/storage';
import { storageConfig } from './storage.config';
import { registerStorageConfigTest } from './storage.config-test';

const clock = fixedClock('2026-09-24T10:00:00Z');
const logger = { warn: () => undefined } as unknown as Ctx['logger'];

function ctxWith(storage: Storage): Ctx {
  return { clock, storage, logger } as unknown as Ctx;
}

beforeAll(() => registerStorageConfigTest());

describe('storage 「测试读写」', () => {
  it('writes, reads back and deletes a probe on the local driver', async () => {
    const storage = memoryStorage();
    const result = await getConfigTest('storage')!.run(
      ctxWith(storage),
      storageConfig.schema.parse({ driver: 'local' }),
      {},
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual([
      '写入探针文件',
      '读回并比对',
      '删除探针文件',
    ]);
    const key = result.steps[0]!.detail!;
    expect(key).toMatch(/^probe\//);
    expect(await storage.exists(key)).toBe(false);
  });

  it('refuses an S3 driver with no credentials before touching the network', async () => {
    const result = await getConfigTest('storage')!.run(
      ctxWith(memoryStorage()),
      storageConfig.schema.parse({ driver: 's3', s3Bucket: 'shop' }),
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.name).toBe('检查配置');
  });

  it('cleans up the probe when reading it back fails', async () => {
    const storage = memoryStorage();
    const broken: Storage = { ...storage, get: () => Promise.reject(new Error('读不到')) };
    const result = await getConfigTest('storage')!.run(
      ctxWith(broken),
      storageConfig.schema.parse({ driver: 'local' }),
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: '读回并比对', ok: false, detail: '读不到' });
    expect(await storage.exists(result.steps[0]!.detail!)).toBe(false);
  });
});
