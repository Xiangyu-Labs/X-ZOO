import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedClock } from '../kernel/clock';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { memoryStorage, type Storage } from '../kernel/storage';
import { storageConfig } from './storage.config';
import { registerStorageConfigTest } from './storage.config-test';
import { safeFetch } from './safe-fetch';

vi.mock('./safe-fetch', () => ({ safeFetch: vi.fn() }));

const clock = fixedClock('2026-09-24T10:00:00Z');
const logger = { warn: () => undefined } as unknown as Ctx['logger'];

function ctxWith(storage: Storage): Ctx {
  return { clock, storage, logger } as unknown as Ctx;
}

beforeAll(() => registerStorageConfigTest());
beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
});

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

  describe('with an image CDN set', () => {
    const settings = storageConfig.schema.parse({
      driver: 'local',
      uploadsCdnOrigin: 'https://IMG.example.com/',
    });

    it('fetches the probe through the CDN, as the mini-program would', async () => {
      const storage = memoryStorage();
      vi.mocked(safeFetch).mockImplementation(async (url) => {
        const key = url.replace('https://img.example.com/uploads/', '');
        return { bytes: await storage.get(key), contentType: 'text/plain', url };
      });

      const result = await getConfigTest('storage')!.run(ctxWith(storage), settings, {});

      expect(result.ok).toBe(true);
      expect(result.steps.map((step) => step.name)).toEqual([
        '写入探针文件',
        '读回并比对',
        '通过图片 CDN 访问',
        '删除探针文件',
      ]);
      expect(result.steps[2]!.detail).toBe(
        `https://img.example.com/uploads/${result.steps[0]!.detail!}`,
      );
    });

    it('says what to check when the CDN does not answer, and still removes the probe', async () => {
      const storage = memoryStorage();
      vi.mocked(safeFetch).mockRejectedValue(new Error('getaddrinfo ENOTFOUND img.example.com'));

      const result = await getConfigTest('storage')!.run(ctxWith(storage), settings, {});

      expect(result.ok).toBe(false);
      const step = result.steps.at(-1)!;
      expect(step).toMatchObject({ name: '通过图片 CDN 访问', ok: false });
      expect(step.detail).toContain('回源');
      expect(step.detail).not.toContain('ENOTFOUND');
      expect(await storage.exists(result.steps[0]!.detail!)).toBe(false);
    });

    it('refuses an origin with a path or plain http on save', () => {
      for (const value of [
        'http://img.example.com',
        'https://img.example.com/uploads',
        'img.example.com',
      ]) {
        expect(storageConfig.schema.safeParse({ uploadsCdnOrigin: value }).success).toBe(false);
      }
      expect(storageConfig.schema.parse({ uploadsCdnOrigin: '' }).uploadsCdnOrigin).toBe('');
    });
  });
});
