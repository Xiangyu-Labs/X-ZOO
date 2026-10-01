import { registerConfigTest, testSteps } from '../kernel/config-test';
import type { Storage } from '../kernel/storage';
import { storageConfig } from './storage.config';
import { safeFetch } from './safe-fetch';
import { s3StorageFor } from './storage.service';

/** How long the public-URL check waits before calling the object unreachable. */
const PUBLIC_FETCH_TIMEOUT_MS = 5000;

/**
 * 存储设置 → 「测试读写」.
 *
 * Writes a small probe file with the values on the screen, reads it back,
 * fetches it from the public URL the storefront would use, and deletes it. A
 * bucket that accepts writes but serves nothing publicly is the classic broken
 * S3 setup — every product image 403s — and only the third step catches it.
 *
 * The probe never enters the media library: it is written through the driver,
 * not `attachmentUpload`, and it is deleted even when a later step fails.
 */
export function registerStorageConfigTest(): void {
  registerConfigTest(storageConfig, {
    label: '测试读写',
    async run(ctx, config) {
      const t = testSteps(ctx);
      if (
        config.driver === 's3' &&
        (config.s3Bucket === '' || config.s3AccessKeyId === '' || config.s3SecretAccessKey === '')
      ) {
        t.fail('检查配置', 'Bucket、AccessKeyId、SecretAccessKey 都要填写');
        return t.result();
      }
      const storage: Storage = config.driver === 's3' ? s3StorageFor(ctx, config) : ctx.storage;
      const body = Buffer.from(`x-zoo storage probe ${ctx.clock.now().toISOString()}\n`);
      let key: string | undefined;

      await t.step('写入探针文件', async () => {
        const stored = await storage.put(body, {
          directory: 'probe',
          filename: 'probe.txt',
          contentType: 'text/plain',
        });
        key = stored.key;
        return stored.key;
      });
      await t.step('读回并比对', async () => {
        const read = await storage.get(key!);
        if (!read.equals(body)) throw new Error('读回的内容与写入的不一致');
        return `${read.length} 字节，一致`;
      });
      if (config.driver === 's3') {
        await t.step('公网地址可访问', async () => {
          const url = storage.url(key!);
          // Through `safeFetch` like every operator-typed URL: https only (the
          // mini-program will not load an http image either), no private hosts.
          const fetched = await safeFetch(url, {
            timeoutMs: PUBLIC_FETCH_TIMEOUT_MS,
            maxBytes: 4096,
          }).catch((error: unknown) => {
            throw new Error(
              `${url}：${error instanceof Error ? error.message : String(error)}。检查 Bucket 的公共读权限和「公网访问地址」`,
            );
          });
          if (!Buffer.from(fetched.bytes).equals(body)) {
            throw new Error(
              `${url} 能打开，但内容不是刚写入的文件，检查「公网访问地址」是否指向这个 Bucket`,
            );
          }
          return url;
        });
      }
      if (t.result().ok) {
        await t.step('删除探针文件', async () => {
          await storage.delete(key!);
          return undefined;
        });
      } else if (key !== undefined) {
        // A later step failed, but the probe must not outlive the test.
        await storage.delete(key).catch((error: unknown) => {
          ctx.logger.warn({ err: error, key }, 'storage probe cleanup failed');
        });
      }
      return t.result();
    },
  });
}
