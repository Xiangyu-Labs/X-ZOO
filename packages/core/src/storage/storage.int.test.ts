import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { admins } from '@shop/db/schema/auth';
import { users } from '@shop/db/schema/user';
import { attachments } from '@shop/db/schema/storage';
import { createTestCtx, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { cleanOrphanAttachments } from './storage.jobs';
import { backfillImageVariants, generateImageVariants } from './image-variants';
import type { Transport } from './safe-fetch';
import { siteConfig } from '../system';
import { storageConfig } from './storage.config';
import { createScanTokenStore } from './scan-token';
import {
  REMOTE_IMPORTS_PER_HOUR,
  SCAN_UPLOADS_PER_IP_PER_HOUR,
  SCAN_UPLOADS_PER_TOKEN,
  attachmentDeleteMany,
  attachmentImport,
  attachmentList,
  attachmentMoveMany,
  attachmentUpdate,
  attachmentUpload,
  categoryCreate,
  categoryDelete,
  categoryTree,
  categoryUpdate,
  GENERATE_IMAGE_VARIANTS_JOB,
  isStoredImageUrl,
  resetStorageDriverCache,
  scanTokenCreate,
  scanTokenStatusGet,
  scanUpload,
  userUpload,
  type IncomingFile,
} from './storage.service';

/**
 * The media library against a real PostgreSQL and a real Redis.
 *
 * The cases that matter are the ones a naive uploader gets wrong: a file whose
 * bytes disagree with its name, a remote URL pointing inside the network, and a
 * scan token that could be used more than once.
 */

let harness: TestCtx;
let adminId: number;
let shopperId: number;
let otherShopperId: number;

const NOW = '2026-09-22T08:00:00.000Z';

/** A structurally real 1×1 PNG, plus a salt so tests can vary the digest. */
function png(width = 1, height = 1, salt = 0): IncomingFile {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = salt;
  return { bytes, filename: 'banner.png', declaredMime: 'image/png' };
}

function file(content: string, filename: string, mime?: string): IncomingFile {
  return { bytes: new TextEncoder().encode(content), filename, declaredMime: mime };
}

function adminActor(id: number, permissions: string[] = []): Actor {
  return { kind: 'admin', id, permissions, isSuper: true };
}

function userActor(id: number): Actor {
  return { kind: 'user', id, permissions: [], isSuper: false };
}

function as(actor: Actor): Ctx {
  return harness.ctx.as(actor);
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected a DomainError');
}

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  resetStorageDriverCache();
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account: 'admin', passwordHash: 'x', passwordAlgo: 'bcrypt', name: '管理员' })
    .returning({ id: admins.id });
  adminId = row!.id;

  const shoppers = await harness.ctx.db
    .insert(users)
    .values([{ account: 'buyer-1' }, { account: 'buyer-2' }])
    .returning({ id: users.id });
  shopperId = shoppers[0]!.id;
  otherShopperId = shoppers[1]!.id;
});

// ---------------------------------------------------------------------------

describe('categories', () => {
  it('builds a flat depth-first tree with direct-member counts', async () => {
    const ctx = as(adminActor(adminId));
    const parent = await categoryCreate(ctx, { name: '商品图', sortOrder: 0 });
    const child = await categoryCreate(ctx, {
      name: '详情页',
      parentId: parent.id,
      sortOrder: 0,
    });
    await attachmentUpload(ctx, { categoryId: child.id }, png());

    const tree = await categoryTree(ctx);
    expect(tree.items.map((i) => [i.name, i.depth, i.path, i.attachmentCount])).toEqual([
      ['商品图', 0, '/', 0],
      ['详情页', 1, `/${parent.id}/`, 1],
    ]);
  });

  it('refuses to make a category its own descendant', async () => {
    const ctx = as(adminActor(adminId));
    const parent = await categoryCreate(ctx, { name: 'a', sortOrder: 0 });
    const child = await categoryCreate(ctx, { name: 'b', parentId: parent.id, sortOrder: 0 });

    expect(
      await code(
        categoryUpdate(ctx, { id: parent.id }, { name: 'a', parentId: child.id, sortOrder: 0 }),
      ),
    ).toBe('STORAGE_CATEGORY_INVALID_PARENT');
  });

  it('rewrites the whole subtree path when a folder moves', async () => {
    const ctx = as(adminActor(adminId));
    const a = await categoryCreate(ctx, { name: 'a', sortOrder: 0 });
    const b = await categoryCreate(ctx, { name: 'b', sortOrder: 1 });
    const inner = await categoryCreate(ctx, { name: 'inner', parentId: a.id, sortOrder: 0 });
    const leaf = await categoryCreate(ctx, { name: 'leaf', parentId: inner.id, sortOrder: 0 });

    await categoryUpdate(ctx, { id: inner.id }, { name: 'inner', parentId: b.id, sortOrder: 0 });

    const byId = new Map((await categoryTree(ctx)).items.map((i) => [i.id, i]));
    expect(byId.get(inner.id)?.path).toBe(`/${b.id}/`);
    // The grandchild moved with it: this is the one a per-row update gets wrong.
    expect(byId.get(leaf.id)?.path).toBe(`/${b.id}/${inner.id}/`);
  });

  it('refuses to delete a folder that still holds anything', async () => {
    const ctx = as(adminActor(adminId));
    const parent = await categoryCreate(ctx, { name: 'a', sortOrder: 0 });
    await categoryCreate(ctx, { name: 'b', parentId: parent.id, sortOrder: 0 });
    expect(await code(categoryDelete(ctx, { id: parent.id }))).toBe('STORAGE_CATEGORY_NOT_EMPTY');

    const withFile = await categoryCreate(ctx, { name: 'c', sortOrder: 0 });
    await attachmentUpload(ctx, { categoryId: withFile.id }, png());
    expect(await code(categoryDelete(ctx, { id: withFile.id }))).toBe('STORAGE_CATEGORY_NOT_EMPTY');
  });

  it('deletes an empty folder', async () => {
    const ctx = as(adminActor(adminId));
    const empty = await categoryCreate(ctx, { name: 'empty', sortOrder: 0 });
    await categoryDelete(ctx, { id: empty.id });
    expect((await categoryTree(ctx)).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('upload', () => {
  it('stores a picture and records what it actually is', async () => {
    const ctx = as(adminActor(adminId));
    const result = await attachmentUpload(ctx, { directory: 'banner' }, png(750, 390));

    expect(result.deduped).toBe(false);
    expect(result.attachment).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      width: 750,
      height: 390,
      driver: 'local',
    });
    // The key is the server's, not the client's filename.
    expect(result.attachment.url).toMatch(/^\/uploads\/banner\/2026\/09\/[0-9a-f]{32}\.png$/);
    expect(result.attachment.originalName).toBe('banner.png');
  });

  it('returns the existing row for identical bytes instead of storing them twice', async () => {
    const ctx = as(adminActor(adminId));
    const first = await attachmentUpload(ctx, {}, png());
    const second = await attachmentUpload(ctx, {}, png());

    expect(second.deduped).toBe(true);
    expect(second.attachment.id).toBe(first.attachment.id);
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(1);
  });

  it('refuses a PHP script named .png with an image content-type', async () => {
    const ctx = as(adminActor(adminId));
    expect(
      await code(
        attachmentUpload(ctx, {}, file('<?php system($_GET["c"]);', 'shell.png', 'image/png')),
      ),
    ).toBe('STORAGE_FILE_TYPE_REJECTED');
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });

  it('refuses an SVG carrying a script', async () => {
    const ctx = as(adminActor(adminId));
    expect(
      await code(
        attachmentUpload(
          ctx,
          {},
          file(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            'logo.svg',
            'image/svg+xml',
          ),
        ),
      ),
    ).toBe('STORAGE_FILE_TYPE_REJECTED');
  });

  it('refuses a PNG declared as a PDF rather than silently correcting it', async () => {
    const ctx = as(adminActor(adminId));
    const mismatched = { ...png(), declaredMime: 'application/pdf' };
    expect(await code(attachmentUpload(ctx, {}, mismatched))).toBe('STORAGE_MIME_MISMATCH');
  });

  it('refuses a file over the configured ceiling', async () => {
    const ctx = as(adminActor(adminId));
    await ctx.config.set(storageConfig, { maxUploadBytes: 64 * 1024 });
    const big: IncomingFile = { ...png(), bytes: new Uint8Array(70 * 1024) };
    big.bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    expect(await code(attachmentUpload(ctx, {}, big))).toBe('STORAGE_FILE_TOO_LARGE');
  });

  it('refuses an upload into a folder that does not exist', async () => {
    const ctx = as(adminActor(adminId));
    expect(await code(attachmentUpload(ctx, { categoryId: '999' }, png()))).toBe(
      'STORAGE_CATEGORY_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------

describe('remote import', () => {
  it('refuses the cloud metadata address', async () => {
    const ctx = as(adminActor(adminId));
    expect(
      await code(attachmentImport(ctx, { url: 'https://169.254.169.254/latest/meta-data/' })),
    ).toBe('STORAGE_REMOTE_URL_REFUSED');
  });

  it('refuses loopback and private addresses', async () => {
    const ctx = as(adminActor(adminId));
    for (const url of [
      'https://127.0.0.1:6379/',
      'https://10.0.0.5/logo.png',
      'file:///etc/passwd',
    ]) {
      expect(await code(attachmentImport(ctx, { url })), url).toBe('STORAGE_REMOTE_URL_REFUSED');
    }
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });

  /** A public CDN, as far as `safeFetch` can tell, answering with `body`. */
  function cdn(body: Uint8Array): {
    calls: string[];
    seam: { resolve: () => Promise<string[]>; transport: Transport };
  } {
    const calls: string[] = [];
    return {
      calls,
      seam: {
        resolve: async () => ['93.184.216.34'],
        transport: async ({ url }) => {
          calls.push(String(url));
          return new Response(body, { headers: { 'content-type': 'image/png' } });
        },
      },
    };
  }

  it('imports an https source into the library', async () => {
    const ctx = as(adminActor(adminId));
    const { calls, seam } = cdn(png(2, 2, 7).bytes);
    const result = await attachmentImport(ctx, { url: 'https://cdn.example.com/banner.png' }, seam);
    expect(result.attachment).toMatchObject({ mime: 'image/png', width: 2, height: 2 });
    expect(calls).toEqual(['https://cdn.example.com/banner.png']);
  });

  // Plain http is the operator's decision, off by default.
  it('refuses plain http unless 允许 http 地址导入 is on', async () => {
    const ctx = as(adminActor(adminId));
    const { calls, seam } = cdn(png(1, 1, 8).bytes);
    expect(
      await code(attachmentImport(ctx, { url: 'http://cdn.example.com/banner.png' }, seam)),
    ).toBe('STORAGE_REMOTE_URL_REFUSED');
    expect(calls).toEqual([]);

    await harness.ctx.config.set(storageConfig, { remoteImportAllowHttp: true });
    await expect(
      attachmentImport(ctx, { url: 'http://cdn.example.com/banner.png' }, seam),
    ).resolves.toMatchObject({ deduped: false });
    expect(calls).toEqual(['http://cdn.example.com/banner.png']);
  });

  it('gives 网址导入 an hourly budget per admin, spent before any lookup', async () => {
    const ctx = as(adminActor(adminId));
    const [second] = await harness.ctx.db
      .insert(admins)
      .values({ account: 'admin-2', passwordHash: 'x', passwordAlgo: 'bcrypt', name: '二号' })
      .returning({ id: admins.id });

    for (let i = 0; i < REMOTE_IMPORTS_PER_HOUR; i += 1) {
      expect(await code(attachmentImport(ctx, { url: `https://10.0.0.${i % 250}/a.png` }))).toBe(
        'STORAGE_REMOTE_URL_REFUSED',
      );
    }
    const { calls, seam } = cdn(png(1, 1, 9).bytes);
    expect(await code(attachmentImport(ctx, { url: 'https://cdn.example.com/a.png' }, seam))).toBe(
      'STORAGE_UPLOAD_RATE_LIMITED',
    );
    expect(calls).toEqual([]);

    // Somebody else's budget is their own.
    await expect(
      attachmentImport(as(adminActor(second!.id)), { url: 'https://cdn.example.com/a.png' }, seam),
    ).resolves.toMatchObject({ deduped: false });
  });
});

// ---------------------------------------------------------------------------

describe('listing, editing and batches', () => {
  it('filters by folder, optionally including its descendants', async () => {
    const ctx = as(adminActor(adminId));
    const parent = await categoryCreate(ctx, { name: 'a', sortOrder: 0 });
    const child = await categoryCreate(ctx, { name: 'b', parentId: parent.id, sortOrder: 0 });
    await attachmentUpload(ctx, { categoryId: parent.id }, png(1, 1, 1));
    await attachmentUpload(ctx, { categoryId: child.id }, png(1, 1, 2));

    const direct = await attachmentList(ctx, {
      page: 1,
      pageSize: 20,
      categoryId: parent.id,
      includeSubcategories: false,
    });
    expect(direct.total).toBe(1);

    const deep = await attachmentList(ctx, {
      page: 1,
      pageSize: 20,
      categoryId: parent.id,
      includeSubcategories: true,
    });
    expect(deep.total).toBe(2);
  });

  it('STOR-015 — searches for the words typed: 100% and a_b are not wildcards', async () => {
    const ctx = as(adminActor(adminId));
    const names = ['满100%减', '满1000减', 'a_b', 'axb'];
    for (const [index, name] of names.entries()) {
      const uploaded = await attachmentUpload(ctx, {}, png(1, 1, 10 + index));
      await attachmentUpdate(ctx, { id: uploaded.attachment.id }, { name });
    }
    const search = async (keyword: string) =>
      (
        await attachmentList(ctx, { page: 1, pageSize: 20, includeSubcategories: false, keyword })
      ).items.map((row) => row.name);

    expect(await search('100%')).toEqual(['满100%减']);
    expect(await search('a_b')).toEqual(['a_b']);
    expect(await search('%')).toEqual(['满100%减']);
  });

  it('renames and re-files without touching the stored object', async () => {
    const ctx = as(adminActor(adminId));
    const folder = await categoryCreate(ctx, { name: 'a', sortOrder: 0 });
    const uploaded = await attachmentUpload(ctx, {}, png());

    const updated = await attachmentUpdate(
      ctx,
      { id: uploaded.attachment.id },
      { name: '首页 banner', categoryId: folder.id },
    );
    expect(updated).toMatchObject({ name: '首页 banner', categoryId: folder.id });
    expect(updated.url).toBe(uploaded.attachment.url);
    expect(updated.sha256).toBe(uploaded.attachment.sha256);
  });

  it('reports ids that were already gone rather than failing the batch', async () => {
    const ctx = as(adminActor(adminId));
    const one = await attachmentUpload(ctx, {}, png(1, 1, 1));
    const two = await attachmentUpload(ctx, {}, png(1, 1, 2));
    await attachmentDeleteMany(ctx, { ids: [two.attachment.id] });

    const result = await attachmentDeleteMany(ctx, {
      ids: [one.attachment.id, two.attachment.id, '9999'],
    });
    expect(result.affected).toBe(1);
    expect(result.skippedIds.sort()).toEqual([two.attachment.id, '9999'].sort());
  });

  it('moves a batch into a folder, and back out to the root', async () => {
    const ctx = as(adminActor(adminId));
    const folder = await categoryCreate(ctx, { name: 'a', sortOrder: 0 });
    const one = await attachmentUpload(ctx, {}, png(1, 1, 1));

    expect(
      await attachmentMoveMany(ctx, { ids: [one.attachment.id], categoryId: folder.id }),
    ).toEqual({ affected: 1, skippedIds: [] });
    expect(await attachmentMoveMany(ctx, { ids: [one.attachment.id], categoryId: null })).toEqual({
      affected: 1,
      skippedIds: [],
    });
  });

  it('hides a deleted attachment from the list without losing the row', async () => {
    const ctx = as(adminActor(adminId));
    const one = await attachmentUpload(ctx, {}, png());
    await attachmentDeleteMany(ctx, { ids: [one.attachment.id] });

    expect(
      (await attachmentList(ctx, { page: 1, pageSize: 20, includeSubcategories: false })).total,
    ).toBe(0);
    // Soft: a description written years ago may still point at the URL.
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('storefront upload', () => {
  it('accepts an image and answers with the file, not the library', async () => {
    const ctx = as(userActor(shopperId));
    const result = await userUpload(ctx, { purpose: 'review' }, png(1080, 1440));
    expect(result).toMatchObject({ mime: 'image/png', width: 1080, height: 1440 });
    expect(result.url).toContain('/uploads/review/');
    expect(Object.keys(result).sort()).toEqual(
      ['height', 'mime', 'name', 'size', 'url', 'width'].sort(),
    );
  });

  it('refuses a PDF: a review photo is not a document', async () => {
    const ctx = as(userActor(shopperId));
    expect(await code(userUpload(ctx, { purpose: 'review' }, file('%PDF-1.4', 'a.pdf')))).toBe(
      'STORAGE_FILE_TYPE_REJECTED',
    );
  });

  it('refuses an SVG from a shopper whatever it is called', async () => {
    const ctx = as(userActor(shopperId));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    for (const [name, mime] of [
      ['avatar.svg', 'image/svg+xml'],
      ['avatar.png', 'image/png'],
    ] as const) {
      expect(await code(userUpload(ctx, { purpose: 'avatar' }, file(svg, name, mime)))).toBe(
        'STORAGE_FILE_TYPE_REJECTED',
      );
    }
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });

  it('refuses an image over the shopper ceiling, and stores nothing', async () => {
    const ctx = as(userActor(shopperId));
    await ctx.config.set(storageConfig, { maxUserUploadBytes: 64 * 1024 });
    const big = png(1, 1);
    const bytes = new Uint8Array(64 * 1024 + 1);
    bytes.set(big.bytes, 0);
    expect(
      await code(userUpload(ctx, { purpose: 'avatar' }, { ...big, bytes, filename: 'big.png' })),
    ).toBe('STORAGE_FILE_TOO_LARGE');
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });

  it('enforces the per-user hourly budget', async () => {
    const ctx = as(userActor(shopperId));
    await ctx.config.set(storageConfig, { userUploadsPerHour: 2 });
    await userUpload(ctx, { purpose: 'review' }, png(1, 1, 1));
    await userUpload(ctx, { purpose: 'review' }, png(1, 1, 2));
    expect(await code(userUpload(ctx, { purpose: 'review' }, png(1, 1, 3)))).toBe(
      'STORAGE_UPLOAD_RATE_LIMITED',
    );

    // A different shopper is unaffected — the limit is per subject, not global.
    await expect(
      userUpload(as(userActor(otherShopperId)), { purpose: 'review' }, png(1, 1, 4)),
    ).resolves.toBeDefined();
  });

  it('attributes the row to the shopper and to no admin', async () => {
    await userUpload(as(userActor(shopperId)), { purpose: 'avatar' }, png());
    const [row] = await harness.ctx.db.select().from(attachments);
    expect(row?.uploadedByUserId).toBe(shopperId);
    expect(row?.uploadedByAdminId).toBeNull();
    // And never into an admin's folder tree.
    expect(row?.categoryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('scan-to-upload', () => {
  it('encodes an absolute address a phone can open, never a bare route', async () => {
    const ctx = as(adminActor(adminId));
    const saved = process.env['PUBLIC_ORIGIN'];
    try {
      process.env['PUBLIC_ORIGIN'] = 'https://shop.example.test/';
      const minted = await scanTokenCreate(ctx, {});
      expect(minted.url).toBe(`https://shop.example.test/scan-upload/${minted.token}`);
    } finally {
      if (saved === undefined) delete process.env['PUBLIC_ORIGIN'];
      else process.env['PUBLIC_ORIGIN'] = saved;
    }
  });

  it('mints a token, accepts one upload, and refuses the second', async () => {
    const ctx = as(adminActor(adminId));
    const minted = await scanTokenCreate(ctx, { directory: 'scan' });

    const first = await scanUpload(harness.ctx, { token: minted.token }, png(1, 1, 1));
    expect(first.attachment.kind).toBe('image');

    // A token that stayed valid until it expired would take this second scan.
    expect(await code(scanUpload(harness.ctx, { token: minted.token }, png(1, 1, 2)))).toBe(
      'STORAGE_SCAN_TOKEN_INVALID',
    );
  });

  it('attributes the phone’s upload to the admin who minted the token', async () => {
    const ctx = as(adminActor(adminId));
    const minted = await scanTokenCreate(ctx, {});
    await scanUpload(harness.ctx, { token: minted.token }, png());

    const [row] = await harness.ctx.db.select().from(attachments);
    expect(row?.uploadedByAdminId).toBe(adminId);
  });

  it('does not burn the token when the file is refused', async () => {
    const ctx = as(adminActor(adminId));
    const minted = await scanTokenCreate(ctx, {});

    expect(
      await code(
        scanUpload(harness.ctx, { token: minted.token }, file('<?php ', 'a.png', 'image/png')),
      ),
    ).toBe('STORAGE_FILE_TYPE_REJECTED');
    // The operator's QR code still works; they just picked the wrong file.
    await expect(scanUpload(harness.ctx, { token: minted.token }, png())).resolves.toBeDefined();
  });

  it('reports the status to the minting admin and hides it from everybody else', async () => {
    const ctx = as(adminActor(adminId));
    const minted = await scanTokenCreate(ctx, {});
    expect(await scanTokenStatusGet(ctx, { token: minted.token })).toEqual({
      state: 'pending',
      attachment: null,
    });

    await scanUpload(harness.ctx, { token: minted.token }, png());
    const used = await scanTokenStatusGet(ctx, { token: minted.token });
    expect(used.state).toBe('used');
    expect(used.attachment?.kind).toBe('image');

    // Another admin learns nothing, not even that the token exists.
    const [other] = await harness.ctx.db
      .insert(admins)
      .values({ account: 'other', passwordHash: 'x', passwordAlgo: 'bcrypt', name: '其他' })
      .returning({ id: admins.id });
    expect(await scanTokenStatusGet(as(adminActor(other!.id)), { token: minted.token })).toEqual({
      state: 'expired',
      attachment: null,
    });
  });

  it('refuses an unknown token', async () => {
    expect(await code(scanUpload(harness.ctx, { token: 'nosuchtokenatall1234' }, png()))).toBe(
      'STORAGE_SCAN_TOKEN_INVALID',
    );
  });

  // An unauthenticated multipart endpoint bounds its work before it parses
  // anything.
  it('throttles per client address before the body is read', async () => {
    let reads = 0;
    const reader = async (): Promise<IncomingFile> => {
      reads += 1;
      return png();
    };
    for (let i = 0; i < SCAN_UPLOADS_PER_IP_PER_HOUR; i += 1) {
      const token = `guess${String(i).padStart(16, '0')}`;
      expect(await code(scanUpload(harness.ctx, { token }, reader, { ip: '203.0.113.30' }))).toBe(
        'STORAGE_SCAN_TOKEN_INVALID',
      );
    }
    // Not one body was read for a code that does not exist.
    expect(reads).toBe(0);

    const minted = await scanTokenCreate(as(adminActor(adminId)), {});
    expect(
      await code(scanUpload(harness.ctx, { token: minted.token }, reader, { ip: '203.0.113.30' })),
    ).toBe('STORAGE_UPLOAD_RATE_LIMITED');
    expect(reads).toBe(0);

    // Another address still gets through, with the real code, and only then
    // is the body read.
    await expect(
      scanUpload(harness.ctx, { token: minted.token }, reader, { ip: '203.0.113.31' }),
    ).resolves.toBeDefined();
    expect(reads).toBe(1);
  });

  it('throttles attempts on one code, whatever address they come from', async () => {
    const minted = await scanTokenCreate(as(adminActor(adminId)), {});
    const refused = () => file('<?php ', 'a.png', 'image/png');
    // Each refused file puts the code back (see above) — which is exactly why
    // the code needs a budget of its own.
    for (let i = 0; i < SCAN_UPLOADS_PER_TOKEN; i += 1) {
      expect(
        await code(
          scanUpload(harness.ctx, { token: minted.token }, refused(), { ip: `198.18.0.${i}` }),
        ),
      ).toBe('STORAGE_FILE_TYPE_REJECTED');
    }
    expect(
      await code(scanUpload(harness.ctx, { token: minted.token }, png(), { ip: '198.18.1.1' })),
    ).toBe('STORAGE_UPLOAD_RATE_LIMITED');
  });

  it('completes only a claimed code: never stamps `used` over a pending one', async () => {
    const minted = await scanTokenCreate(as(adminActor(adminId)), {});
    const store = createScanTokenStore(harness.ctx.redis, () => harness.ctx.clock.now());

    expect(await store.complete(minted.token, 42)).toBe(false);
    expect(await store.read(minted.token)).toMatchObject({ state: 'pending', attachmentId: null });
    expect(await store.complete('nosuchtokenatall1234', 42)).toBe(false);

    expect(await store.claim(minted.token)).not.toBeNull();
    expect(await store.complete(minted.token, 42)).toBe(true);
    expect(await store.read(minted.token)).toMatchObject({ state: 'used', attachmentId: 42 });
    // And a used one is not completed twice.
    expect(await store.complete(minted.token, 43)).toBe(false);
    expect(await store.read(minted.token)).toMatchObject({ attachmentId: 42 });
  });
});

// ---------------------------------------------------------------------------

describe('cleanOrphans', () => {
  it('leaves a tombstone alone until the retention window has passed', async () => {
    const ctx = as(adminActor(adminId));
    const one = await attachmentUpload(ctx, {}, png());
    await attachmentDeleteMany(ctx, { ids: [one.attachment.id] });

    harness.clock.set('2026-09-25T08:00:00.000Z'); // 3 days, retention is 7
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ removed: 0 });
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(1);
  });

  it('purges the row and the object once it is old enough', async () => {
    const ctx = as(adminActor(adminId));
    const one = await attachmentUpload(ctx, {}, png());
    const key = (
      await harness.ctx.db
        .select({ key: attachments.storageKey })
        .from(attachments)
        .where(eq(attachments.id, Number(one.attachment.id)))
    )[0]!.key;
    await attachmentDeleteMany(ctx, { ids: [one.attachment.id] });

    harness.clock.set('2026-10-05T08:00:00.000Z');
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ removed: 1, failed: 0 });
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
    expect(await harness.ctx.storage.exists(key)).toBe(false);
  });

  it('does nothing at all when retention is disabled', async () => {
    const ctx = as(adminActor(adminId));
    await ctx.config.set(storageConfig, { orphanRetentionDays: 0 });
    const one = await attachmentUpload(ctx, {}, png());
    await attachmentDeleteMany(ctx, { ids: [one.attachment.id] });

    harness.clock.set('2027-01-01T00:00:00.000Z');
    expect(await cleanOrphanAttachments(ctx)).toEqual({
      examined: 0,
      removed: 0,
      kept: 0,
      failed: 0,
    });
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(1);
  });

  // Deleting from the library says nothing about the content that shows the
  // picture: a logo, an avatar, a product description. The sweep asks the
  // content before it removes the bytes.
  it('keeps a picture the shop still shows, deleted from the library or not', async () => {
    const ctx = as(adminActor(adminId));
    const logo = await attachmentUpload(ctx, {}, png(1, 1, 1));
    const avatar = await attachmentUpload(ctx, {}, png(1, 1, 2));
    const unused = await attachmentUpload(ctx, {}, png(1, 1, 3));
    const logoKey = await storageKeyOf(logo.attachment.id);
    const avatarKey = await storageKeyOf(avatar.attachment.id);
    // A JSON config value, and a thumbnail of the other in a plain column.
    await ctx.config.set(siteConfig, { logo: logo.attachment.url });
    await harness.ctx.db
      .update(users)
      .set({ avatarUrl: avatar.attachment.url.replace(/\.png$/, '.w480.png') })
      .where(eq(users.id, shopperId));
    await attachmentDeleteMany(ctx, {
      ids: [logo.attachment.id, avatar.attachment.id, unused.attachment.id],
    });

    harness.clock.set('2026-10-05T08:00:00.000Z');
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ removed: 1, kept: 2, failed: 0 });
    expect(await harness.ctx.storage.exists(logoKey)).toBe(true);
    expect(await harness.ctx.storage.exists(avatarKey)).toBe(true);
    const left = await harness.ctx.db.select({ id: attachments.id }).from(attachments);
    expect(left.map((row) => String(row.id)).sort()).toEqual(
      [logo.attachment.id, avatar.attachment.id].sort(),
    );
  });

  it('asks again a retention later, and sweeps what the content has let go of', async () => {
    const ctx = as(adminActor(adminId));
    const logo = await attachmentUpload(ctx, {}, png(1, 1, 1));
    await ctx.config.set(siteConfig, { logo: logo.attachment.url });
    await attachmentDeleteMany(ctx, { ids: [logo.attachment.id] });

    harness.clock.set('2026-10-05T08:00:00.000Z');
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ kept: 1 });
    // A kept row goes to the back of the queue rather than being examined (and
    // filling the batch) on every run.
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ examined: 0 });

    await ctx.config.set(siteConfig, { logo: '' });
    harness.clock.set('2026-10-13T08:00:00.000Z');
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ removed: 1, kept: 0 });
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/** A real JPEG, noisy enough that a smaller copy really is smaller. */
async function jpeg(width: number, height: number, salt = 0): Promise<IncomingFile> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = ((i + salt) * 2654435761) >>> 24;
  const bytes = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  return { bytes: new Uint8Array(bytes), filename: 'photo.jpg', declaredMime: 'image/jpeg' };
}

async function storageKeyOf(attachmentId: string): Promise<string> {
  const [row] = await harness.ctx.db
    .select({ key: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.id, Number(attachmentId)));
  return row!.key;
}

const variantKey = (key: string, width: 480 | 960) => key.replace(/\.(\w+)$/, `.w${width}.$1`);

describe('image variants', () => {
  it('a new image upload asks the worker for its thumbnails, after commit, once', async () => {
    harness.queue.reset();
    const ctx = as(adminActor(adminId));
    const first = await attachmentUpload(ctx, { directory: 'product' }, await jpeg(1200, 800));
    await attachmentUpload(ctx, { directory: 'product' }, await jpeg(1200, 800)); // deduped
    await attachmentUpload(ctx, {}, file('%PDF-1.7\n', 'terms.pdf', 'application/pdf'));

    expect(harness.queue.jobs).toEqual([
      {
        jobName: GENERATE_IMAGE_VARIANTS_JOB,
        payload: { attachmentId: first.attachment.id },
        options: { dedupeKey: `storage-variants:${first.attachment.id}` },
      },
    ]);
  });

  it('writes a 480 and a 960 px copy next to the original, and is idempotent', async () => {
    const ctx = as(adminActor(adminId));
    const uploaded = await attachmentUpload(ctx, { directory: 'product' }, await jpeg(1200, 800));
    const key = await storageKeyOf(uploaded.attachment.id);

    const report = await generateImageVariants(ctx, { attachmentId: uploaded.attachment.id });
    expect(report.written).toEqual([480, 960]);
    for (const width of [480, 960] as const) {
      const meta = await sharp(await harness.ctx.storage.get(variantKey(key, width))).metadata();
      expect(meta.width).toBe(width);
      expect(meta.format).toBe('jpeg');
    }
    // The original is untouched, and a second run finds nothing to do.
    expect((await sharp(await harness.ctx.storage.get(key)).metadata()).width).toBe(1200);
    expect(await generateImageVariants(ctx, { attachmentId: uploaded.attachment.id })).toEqual({
      attachmentId: uploaded.attachment.id,
      written: [],
      skipped: 'present',
    });
  });

  it('fails soft: bytes it cannot decode leave the upload as it was, with no thumbnail', async () => {
    const ctx = as(adminActor(adminId));
    // A PNG header with nothing behind it: the sniffer accepts it, libvips cannot decode it.
    const uploaded = await attachmentUpload(ctx, { directory: 'product' }, png(960, 390));
    const key = await storageKeyOf(uploaded.attachment.id);

    const report = await generateImageVariants(ctx, { attachmentId: uploaded.attachment.id });
    expect(report).toMatchObject({ written: [], skipped: 'failed' });
    expect(await harness.ctx.storage.exists(key)).toBe(true);
    expect(await harness.ctx.storage.exists(variantKey(key, 480))).toBe(false);
  });

  it('CAT-018 — a thumbnail of a live image counts as ours, a thumbnail of anything else does not', async () => {
    const ctx = as(adminActor(adminId));
    const uploaded = await attachmentUpload(ctx, { directory: 'review' }, await jpeg(900, 900));
    const url = uploaded.attachment.url;

    expect(await isStoredImageUrl(ctx, url.replace(/\.jpg$/, '.w480.jpg'))).toBe(true);
    expect(await isStoredImageUrl(ctx, url.replace(/\.jpg$/, '.w500.jpg'))).toBe(false);
    // The widths before X2 (360 / 750) were never live; their names are nobody's thumbnail.
    expect(await isStoredImageUrl(ctx, url.replace(/\.jpg$/, '.w360.jpg'))).toBe(false);
    expect(
      await isStoredImageUrl(
        ctx,
        '/uploads/review/2026/09/ffffffffffffffffffffffffffffffff.w480.jpg',
      ),
    ).toBe(false);

    await attachmentDeleteMany(ctx, { ids: [uploaded.attachment.id] });
    expect(await isStoredImageUrl(ctx, url.replace(/\.jpg$/, '.w480.jpg'))).toBe(false);
  });

  it('the orphan sweep removes the thumbnails with their original', async () => {
    const ctx = as(adminActor(adminId));
    const uploaded = await attachmentUpload(ctx, { directory: 'product' }, await jpeg(1200, 800));
    const key = await storageKeyOf(uploaded.attachment.id);
    await generateImageVariants(ctx, { attachmentId: uploaded.attachment.id });
    await attachmentDeleteMany(ctx, { ids: [uploaded.attachment.id] });

    harness.clock.set('2026-10-05T08:00:00.000Z');
    expect(await cleanOrphanAttachments(ctx)).toMatchObject({ removed: 1, failed: 0 });
    for (const gone of [key, variantKey(key, 480), variantKey(key, 960)]) {
      expect(await harness.ctx.storage.exists(gone)).toBe(false);
    }
  });

  it('the backfill walks the library in id order, batch by batch, skipping the deleted', async () => {
    const ctx = as(adminActor(adminId));
    const ids: string[] = [];
    for (let salt = 0; salt < 3; salt += 1) {
      ids.push(
        (await attachmentUpload(ctx, { directory: 'product' }, await jpeg(800, 600, salt)))
          .attachment.id,
      );
    }
    await attachmentDeleteMany(ctx, { ids: [ids[1]!] });

    const first = await backfillImageVariants(ctx, { limit: 1 });
    expect(first).toEqual({ examined: 1, written: 1, failed: 0, nextAfterId: ids[0] });
    const second = await backfillImageVariants(ctx, { afterId: first.nextAfterId!, limit: 1 });
    expect(second).toEqual({ examined: 1, written: 1, failed: 0, nextAfterId: ids[2] });
    expect(await backfillImageVariants(ctx, { afterId: second.nextAfterId!, limit: 1 })).toEqual({
      examined: 0,
      written: 0,
      failed: 0,
      nextAfterId: null,
    });

    const deletedKey = await storageKeyOf(ids[1]!);
    expect(await harness.ctx.storage.exists(variantKey(deletedKey, 480))).toBe(false);
    // Run again over everything: nothing left to write.
    expect(await backfillImageVariants(ctx, { limit: 10 })).toMatchObject({
      examined: 2,
      written: 0,
    });
  });
});
