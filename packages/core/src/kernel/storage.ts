import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { imageVariantKey, type ImageVariantWidth } from '@shop/contracts/storage/image-variants';

/**
 * The storage port and its local-disk driver.
 *
 * Two classic upload holes meet here: trusting a client-supplied path, and
 * fetching a user-supplied URL. So:
 *
 *  - **the server generates the key**, always. `put()` takes a directory hint
 *    and a filename hint and returns the key it chose; a caller cannot pick one.
 *  - fetching a remote URL is NOT part of this port. It belongs in
 *    `core/src/storage/safe-fetch.ts`, owned by the storage domain.
 */

export interface PutOptions {
  /** Logical folder, e.g. `product` or `diy`. Sanitised to `[a-z0-9-]`. */
  directory?: string;
  /** Original filename; only its extension is honoured, and only if it is safe. */
  filename?: string;
  contentType?: string;
  /** Seconds. Local driver ignores it; S3 maps it to Cache-Control. */
  maxAge?: number;
}

export interface StoredObject {
  /** Server-generated storage key, e.g. `product/2026/02/1a2b3c4d.png`. */
  key: string;
  size: number;
  contentType: string;
  /** Lowercase hex sha256 of the bytes, so a copy can be verified. */
  sha256: string;
}

export interface Storage {
  put(body: Buffer | Uint8Array, options?: PutOptions): Promise<StoredObject>;
  /**
   * Writes an image variant next to a stored original and returns its key.
   * The key is derived from the original's (`imageVariantKey`), never chosen:
   * a key `put()` did not generate, or a width that is not generated, throws.
   * Overwrites an existing variant.
   */
  putVariant(
    key: string,
    width: ImageVariantWidth,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Public URL for a key. Site-relative for the local driver. */
  url(key: string): string;
  exists(key: string): Promise<boolean>;
}

/**
 * The only extensions we will ever write to disk. Anything else becomes
 * `.bin`, which the nginx `/uploads/` rules already refuse to execute.
 */
const SAFE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'mp4',
  'mp3',
  'wav',
  'pdf',
  'xlsx',
  'xls',
  'csv',
  'zip',
  'json',
  'txt',
]);

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain',
};

export function sanitiseDirectory(input: string | undefined): string {
  const cleaned = (input ?? 'misc')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : 'misc';
}

export function safeExtension(filename: string | undefined): string {
  const raw = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  const cleaned = raw.replace(/[^a-z0-9]/g, '').slice(0, 8);
  return SAFE_EXTENSIONS.has(cleaned) ? cleaned : 'bin';
}

/**
 * The key a client could never choose: a fixed directory whitelist, a
 * date-sharded prefix (so one folder never holds a million files) and a random
 * basename. No part of it comes from user input except the extension, and that
 * is whitelisted.
 */
export function buildStorageKey(now: Date, options: PutOptions = {}): string {
  const directory = sanitiseDirectory(options.directory);
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const extension = safeExtension(options.filename);
  return `${directory}/${year}/${month}/${randomUUID().replace(/-/g, '')}.${extension}`;
}

/** The variant key for `putVariant`, or a throw: the port's key rule, in one place. */
export function requireVariantKey(key: string, width: ImageVariantWidth): string {
  const variant = imageVariantKey(key, width);
  if (!variant) throw new Error('storage: 该文件没有缩略图');
  return variant;
}

export interface LocalStorageOptions {
  /** Absolute path of the uploads root. */
  root: string;
  /** Public prefix the edge serves `root` at. */
  publicPrefix?: string;
  now?: () => Date;
}

export function createLocalStorage(options: LocalStorageOptions): Storage {
  const root = path.resolve(options.root);
  const publicPrefix = (options.publicPrefix ?? '/uploads').replace(/\/$/, '');
  const now = options.now ?? (() => new Date(Date.now()));

  /** Refuses anything that escapes `root`, however it was spelled. */
  const resolveKey = (key: string): string => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
      throw new Error('storage: 非法的存储 key');
    }
    if (key.includes('\0') || key.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(key)) {
      throw new Error('storage: 非法的存储 key');
    }
    const full = path.resolve(root, key);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('storage: 非法的存储 key');
    }
    return full;
  };

  return {
    async put(body, putOptions = {}) {
      const key = buildStorageKey(now(), putOptions);
      const full = resolveKey(key);
      await mkdir(path.dirname(full), { recursive: true });
      const buffer = Buffer.from(body);
      await writeFile(full, buffer, { mode: 0o644 });
      const extension = key.split('.').pop() ?? 'bin';
      return {
        key,
        size: buffer.byteLength,
        contentType:
          putOptions.contentType ?? CONTENT_TYPES[extension] ?? 'application/octet-stream',
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
    },
    async putVariant(key, width, body) {
      const variant = requireVariantKey(key, width);
      const full = resolveKey(variant);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, Buffer.from(body), { mode: 0o644 });
      return variant;
    },
    async get(key) {
      return readFile(resolveKey(key));
    },
    async delete(key) {
      await rm(resolveKey(key), { force: true });
    },
    url(key) {
      return `${publicPrefix}/${key.replace(/^\/+/, '')}`;
    },
    async exists(key) {
      try {
        await stat(resolveKey(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Reading a stored file without buffering it. Used by the download endpoints. */
export function localReadStream(root: string, key: string): ReturnType<typeof createReadStream> {
  const full = path.resolve(root, key);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('storage: 非法的存储 key');
  }
  return createReadStream(full);
}

/** In-memory driver for unit tests. Same key-generation rules as the real one. */
export function memoryStorage(now: () => Date = () => new Date(0)): Storage & {
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(body, options = {}) {
      const key = buildStorageKey(now(), options);
      const buffer = Buffer.from(body);
      files.set(key, buffer);
      const extension = key.split('.').pop() ?? 'bin';
      return {
        key,
        size: buffer.byteLength,
        contentType: options.contentType ?? CONTENT_TYPES[extension] ?? 'application/octet-stream',
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
    },
    async putVariant(key, width, body) {
      const variant = requireVariantKey(key, width);
      files.set(variant, Buffer.from(body));
      return variant;
    },
    async get(key) {
      const found = files.get(key);
      if (!found) throw new Error(`storage: 找不到 ${key}`);
      return found;
    },
    async delete(key) {
      files.delete(key);
    },
    url: (key) => `/uploads/${key}`,
    async exists(key) {
      return files.has(key);
    },
  };
}
