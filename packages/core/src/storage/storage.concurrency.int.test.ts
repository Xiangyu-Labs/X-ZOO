import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admins } from '@shop/db/schema/auth';
import { attachmentCategories, attachments } from '@shop/db/schema/storage';
import { sql } from 'drizzle-orm';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import type { DomainError } from '../kernel/errors';
import {
  attachmentUpload,
  categoryCreate,
  categoryDelete,
  resetStorageDriverCache,
  scanTokenCreate,
  scanUpload,
  type IncomingFile,
} from './storage.service';

/**
 * Every conditional state change in `storage`, raced.
 *
 * `runConcurrently` releases all of the callers in the same tick, so a
 * read-then-write bug that a sequential test never notices shows up here as two
 * winners.
 */

let harness: TestCtx;
let adminId: number;

const NOW = '2026-09-22T08:00:00.000Z';
const WORKERS = 6;
/** Rounds for the two-writer races: the window is narrow, one attempt proves nothing. */
const ROUNDS = 30;

function png(salt = 0): IncomingFile {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(16, 1, false);
  new DataView(bytes.buffer).setUint32(20, 1, false);
  bytes[24] = salt;
  return { bytes, filename: 'banner.png', declaredMime: 'image/png' };
}

function adminActor(id: number): Actor {
  return { kind: 'admin', id, permissions: [], isSuper: true };
}

/** A context with its own connection, so the callers really contend. */
function fork(index: number): Ctx {
  return forkTestCtx(harness, {
    actor: adminActor(adminId),
    requestId: `race-${index}`,
  });
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
});

describe('sha256 dedupe under concurrency', () => {
  it('stores identical bytes exactly once when six uploads collide', async () => {
    // Somebody double-clicks 上传; six requests arrive carrying the same file.
    // Without the digest-scoped advisory lock all six read "not there" and the
    // library grows six twins.
    const report = await runConcurrently(
      WORKERS,
      (index) => attachmentUpload(fork(index), { directory: 'race' }, png()),
      { isWinner: (result) => !result.deduped },
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    expect(report.losers).toBe(WORKERS - 1);

    const rows = await harness.ctx.db.select().from(attachments);
    expect(rows).toHaveLength(1);

    // And every caller got the same row back, not a 409.
    const ids = new Set(report.fulfilled.map((r) => r.attachment.id));
    expect(ids.size).toBe(1);
  });

  it('does not serialise uploads of different files behind each other', async () => {
    // The lock is keyed on the digest, not taken globally: six different files
    // all win.
    const report = await runConcurrently(
      WORKERS,
      (index) => attachmentUpload(fork(index), {}, png(index + 1)),
      { isWinner: (result) => !result.deduped },
    );
    expect(report.winners).toBe(WORKERS);
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(WORKERS);
  });
});

describe('scan tokens are single-use', () => {
  it('lets exactly one of six phones upload through one QR code', async () => {
    // One global token would have accepted all six.
    const minted = await scanTokenCreate(harness.ctx.as(adminActor(adminId)), {});

    const report = await runConcurrently(WORKERS, (index) =>
      scanUpload(fork(index), { token: minted.token }, png(index + 1)),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(WORKERS - 1);
    for (const error of report.rejected) {
      expect((error as DomainError).code).toBe('STORAGE_SCAN_TOKEN_INVALID');
    }
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(1);
  });
});

describe('deleting a folder', () => {
  it('lets exactly one of six deletions of the same folder win', async () => {
    const folder = await categoryCreate(harness.ctx.as(adminActor(adminId)), {
      name: 'race',
      sortOrder: 0,
    });

    const report = await runConcurrently(WORKERS, (index) =>
      categoryDelete(fork(index), { id: folder.id }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(WORKERS - 1);
    for (const error of report.rejected) {
      // Gone, not "still holds things" — the loser read the tombstone.
      expect((error as DomainError).code).toBe('STORAGE_CATEGORY_NOT_FOUND');
    }
  });

  it('never deletes a folder that a concurrent upload just filed into', async () => {
    // Thirty rounds, because this one is a *timing* window rather than a
    // logical one: the first version of this code put the emptiness guard
    // inside the DELETE and passed seven runs out of eight. Under READ
    // COMMITTED that guard cannot see the uploader's uncommitted insert, and
    // the uploader's "is the folder alive" read cannot see the uncommitted
    // soft-delete, so both committed and the picture became invisible —
    // in the folder tree it no longer had, and in no other folder either.
    const ctx = harness.ctx.as(adminActor(adminId));

    for (let round = 0; round < ROUNDS; round += 1) {
      const folder = await categoryCreate(ctx, { name: `race-${round}`, sortOrder: 0 });

      const [deletion, upload] = await Promise.allSettled([
        categoryDelete(fork(1), { id: folder.id }),
        // A distinct file each round: an identical one would dedupe onto the
        // previous round's row and never test the insert.
        attachmentUpload(fork(2), { categoryId: folder.id }, png(round + 1)),
      ]);

      // Exactly one of the two, which is the only thing a serial order allows:
      // upload-then-delete refuses the delete as not-empty, delete-then-upload
      // refuses the upload as not-found.
      const won = [deletion, upload].filter((o) => o?.status === 'fulfilled');
      expect(won, `round ${round}`).toHaveLength(1);

      await expectNoOrphans(`round ${round}`);
    }
  });

  it('never creates a child under a folder that is being deleted', async () => {
    // Same window, other table: a live child in a deleted parent is a subtree
    // the tree walk cannot reach, so the folder and everything under it vanish.
    const ctx = harness.ctx.as(adminActor(adminId));

    for (let round = 0; round < ROUNDS; round += 1) {
      const parent = await categoryCreate(ctx, { name: `parent-${round}`, sortOrder: 0 });

      const [deletion, creation] = await Promise.allSettled([
        categoryDelete(fork(1), { id: parent.id }),
        categoryCreate(fork(2), { name: `child-${round}`, parentId: parent.id, sortOrder: 0 }),
      ]);

      const won = [deletion, creation].filter((o) => o?.status === 'fulfilled');
      expect(won, `round ${round}`).toHaveLength(1);

      await expectNoOrphans(`round ${round}`);
    }
  });
});

/**
 * The invariant both races exist to protect, asserted over the whole database
 * rather than over the two promises: nothing live may hang off a tombstone.
 */
async function expectNoOrphans(label: string): Promise<void> {
  const orphanedFiles = await harness.ctx.db.execute(sql`
    select a.id from ${attachments} a
      join ${attachmentCategories} c on c.id = a.category_id
     where a.deleted_at is null and c.deleted_at is not null`);
  expect(orphanedFiles.rows, `${label}: live file in a deleted folder`).toEqual([]);

  const orphanedFolders = await harness.ctx.db.execute(sql`
    select c.id from ${attachmentCategories} c
      join ${attachmentCategories} p on p.id = c.parent_id
     where c.deleted_at is null and p.deleted_at is not null`);
  expect(orphanedFolders.rows, `${label}: live folder under a deleted parent`).toEqual([]);
}
