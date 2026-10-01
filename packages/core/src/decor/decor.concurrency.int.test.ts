import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { decorDocuments, decorRevisions } from '@shop/db/schema/decor';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import * as decor from './index';

/**
 * The races in 页面装修 v2. Every conditional state change in the domain:
 *
 * - the draft save, conditional on `draft_version` (DECOR-010);
 * - the publish and the rollback, under the document's row lock, numbering
 *   revisions (DECOR-006, DECOR-007, DECOR-011);
 * - the designation, under an advisory lock and a partial unique index
 *   (DECOR-008);
 * - the delete, conditional on the document not being designated (DECOR-009).
 *
 * Each caller runs on its own pooled connection (`forkTestCtx`) and all are
 * released from one barrier (`runConcurrently`), so they meet on the row.
 */

let harness: TestCtx;
let ctx: Ctx;

const NOW = '2026-06-01T00:00:00.000Z';
const admin = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });
const racer = (index: number): Ctx => forkTestCtx(harness, { actor: admin(index + 1) });

const N = 8;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, actor: admin(1) });
  ctx = harness.ctx;
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
});

function doc(label: string) {
  return {
    schemaVersion: 2 as const,
    root: { props: { title: '测试页', background: '#f5f5f5', shareEnabled: true, shareTitle: '' } },
    blocks: [
      {
        id: `b-${label}`,
        type: 'carousel',
        v: 1,
        props: { slides: [{ image: 'https://cdn.example.com/a.jpg', alt: label }] },
      },
    ],
  };
}

const codes = (rejected: unknown[]) => rejected.map((error) => (error as { code?: string }).code);

async function published(kind: 'home' | 'custom' = 'custom'): Promise<string> {
  const created = await decor.createDocument(ctx, { kind, name: '页' });
  await decor.saveDraft(ctx, {
    id: created.id,
    document: doc('first'),
    version: created.draftVersion,
  });
  await decor.publish(ctx, { id: created.id, note: '' });
  return created.id;
}

async function revisionsOf(id: string) {
  return ctx.db
    .select({ number: decorRevisions.number, restoredFrom: decorRevisions.restoredFrom })
    .from(decorRevisions)
    .where(eq(decorRevisions.documentId, Number(id)))
    .orderBy(decorRevisions.number);
}

describe('concurrent draft saves — DECOR-010', () => {
  it('DECOR-010: of N saves on the same version exactly one lands; the rest are version conflicts', async () => {
    const created = await decor.createDocument(ctx, { kind: 'custom', name: '页' });
    const report = await runConcurrently(N, (index) =>
      decor.saveDraft(racer(index), {
        id: created.id,
        document: doc(`editor-${index}`),
        version: created.draftVersion,
      }),
    );
    expect(report.fulfilled).toHaveLength(1);
    expect(codes(report.rejected)).toEqual(Array(N - 1).fill('DECOR_VERSION_CONFLICT'));

    const winner = report.results.find((result) => result.status === 'fulfilled')!;
    const detail = await decor.getDocument(ctx, { id: created.id });
    expect(detail.draftVersion).toBe('2');
    // The stored draft is the winner's, whole — not a mix.
    expect(detail.draft.blocks[0]!.id).toBe(`b-editor-${winner.index}`);
  });
});

describe('concurrent publishes — DECOR-007', () => {
  it('DECOR-007: N publishes of the same draft make one revision; the rest are nothing to publish', async () => {
    const created = await decor.createDocument(ctx, { kind: 'custom', name: '页' });
    await decor.saveDraft(ctx, {
      id: created.id,
      document: doc('only'),
      version: created.draftVersion,
    });
    const report = await runConcurrently(N, (index) =>
      decor.publish(racer(index), { id: created.id, note: `第${index}次` }),
    );
    expect(report.fulfilled).toHaveLength(1);
    expect(codes(report.rejected)).toEqual(Array(N - 1).fill('DECOR_NOTHING_TO_PUBLISH'));
    expect(await revisionsOf(created.id)).toEqual([{ number: 1, restoredFrom: null }]);

    const detail = await decor.getDocument(ctx, { id: created.id });
    expect(detail.published?.id).toBe(report.fulfilled[0]!.revision.id);
    expect(detail.hasUnpublishedChanges).toBe(false);
  });

  it('DECOR-007: publishes racing saves never publish a version the publisher did not name', async () => {
    const created = await decor.createDocument(ctx, { kind: 'custom', name: '页' });
    const base = await decor.saveDraft(ctx, {
      id: created.id,
      document: doc('base'),
      version: created.draftVersion,
    });
    const report = await runConcurrently(N, (index): Promise<unknown> =>
      index % 2 === 0
        ? decor.publish(racer(index), { id: created.id, version: base.version, note: '' })
        : decor.saveDraft(racer(index), {
            id: created.id,
            document: doc(`edit-${index}`),
            version: base.version,
          }),
    );
    const revisions = await revisionsOf(created.id);
    expect(revisions.length).toBeLessThanOrEqual(1);
    if (revisions.length === 1) {
      const content = await decor.getRevision(ctx, { id: created.id, number: 1 });
      expect(content.content.blocks[0]!.id).toBe('b-base');
    }
    for (const code of codes(report.rejected)) {
      expect(['DECOR_VERSION_CONFLICT', 'DECOR_NOTHING_TO_PUBLISH']).toContain(code);
    }
  });
});

describe('concurrent rollbacks — DECOR-011', () => {
  it('DECOR-011: N rollbacks at once each append a revision, numbered without gaps or duplicates', async () => {
    const id = await published();
    const report = await runConcurrently(N, (index) =>
      decor.rollback(racer(index), { id, number: 1, note: '' }),
    );
    expect(report.fulfilled).toHaveLength(N);
    const revisions = await revisionsOf(id);
    expect(revisions.map((revision) => revision.number)).toEqual(
      Array.from({ length: N + 1 }, (_unused, index) => index + 1),
    );
    const detail = await decor.getDocument(ctx, { id });
    expect(detail.published?.number).toBe(N + 1);
  });
});

describe('concurrent designations — DECOR-008', () => {
  it('DECOR-008: N documents designated as 首页 at once leave exactly one designated', async () => {
    const ids: string[] = [];
    for (let index = 0; index < N; index += 1) ids.push(await published('home'));

    const report = await runConcurrently(N, (index) =>
      decor.designate(racer(index), { designation: 'home', documentId: ids[index]! }),
    );
    expect(report.rejected).toEqual([]);
    const designated = await ctx.db
      .select({ id: decorDocuments.id })
      .from(decorDocuments)
      .where(eq(decorDocuments.designation, 'home'));
    expect(designated).toHaveLength(1);
    const current = await decor.getDesignations(ctx);
    expect(current.home?.id).toBe(String(designated[0]!.id));
  });
});

describe('delete against designate — DECOR-009', () => {
  it('DECOR-009: a delete racing a designation never leaves a deleted document designated', async () => {
    for (let round = 0; round < 10; round += 1) {
      await decor.designate(ctx, { designation: 'home', documentId: null });
      const id = await published('home');
      const report = await runConcurrently(2, (index): Promise<unknown> =>
        index === 0
          ? decor.designate(racer(0), { designation: 'home', documentId: id })
          : decor.deleteDocument(racer(1), { id }),
      );
      // Exactly one of them wins; the loser says why.
      expect(report.fulfilled).toHaveLength(1);
      const loser = codes(report.rejected)[0];
      const designatedFirst = report.results[0]!.status === 'fulfilled';
      expect(loser).toBe(designatedFirst ? 'DECOR_DOCUMENT_IN_USE' : 'DECOR_DOCUMENT_NOT_FOUND');

      const zombies = await ctx.db
        .select({ id: decorDocuments.id })
        .from(decorDocuments)
        .where(and(isNotNull(decorDocuments.designation), isNotNull(decorDocuments.deletedAt)));
      expect(zombies).toEqual([]);
      const liveHome = await ctx.db
        .select({ id: decorDocuments.id })
        .from(decorDocuments)
        .where(and(eq(decorDocuments.designation, 'home'), isNull(decorDocuments.deletedAt)));
      expect(liveHome).toHaveLength(designatedFirst ? 1 : 0);
    }
  });
});
