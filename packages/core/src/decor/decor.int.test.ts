import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import { blockProps } from '@shop/contracts/decor/base';
import { USER_CENTER_DEFAULT_VERSION } from '@shop/contracts/decor/defaults';
import { createBlockRegistry, defineBlock } from '@shop/contracts/decor/registry';
import { articleSource, couponSource, need } from '@shop/contracts/decor/sources';
import {
  productCategories,
  productCategoriesMap,
  productFavorites,
  productLabelCategories,
  productLabels,
  productLabelsMap,
  products,
} from '@shop/db/schema/catalog';
import { articles } from '@shop/db/schema/cms';
import { couponTemplates } from '@shop/db/schema/coupon';
import { decorDocuments, decorRevisions } from '@shop/db/schema/decor';
import { groupbuyActivities } from '@shop/db/schema/groupbuy';
import { orders } from '@shop/db/schema/order';
import { presaleActivities } from '@shop/db/schema/presale';
import { refunds } from '@shop/db/schema/refund';
import { users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, type TestCtx } from '@shop/testing';
import * as coupon from '../coupon';
import { anonymousActor, type Actor, type Ctx } from '../kernel/context';
import { withTx } from '../kernel/tx';
import * as decor from './index';

/**
 * 页面装修 v2, against real PostgreSQL and Redis: the admin side (documents,
 * drafts, revisions, designations, preview tokens) and the storefront
 * resolver (visibility of data, cache, per-request filtering, per-shopper
 * state). The races are in `decor.concurrency.int.test.ts`.
 */

let harness: TestCtx;
let ctx: Ctx;

const NOW = '2026-06-01T00:00:00.000Z';
const admin: Actor = { kind: 'admin', id: 1, permissions: [], isSuper: true };
const shopper = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, actor: admin });
  ctx = harness.ctx;
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const anonymous = () => harness.as(anonymousActor);
const NO_CLIENT = { clientVersion: null } as const;

function doc(blocks: unknown[], title = '测试页') {
  return {
    schemaVersion: 2 as const,
    root: { props: { title, background: '#f5f5f5', shareEnabled: true, shareTitle: '' } },
    blocks: blocks as { id: string; type: string; v: number; props: Record<string, unknown> }[],
  };
}

const grid = (id: string, source: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'productGrid',
  v: 1,
  props: { source, ...extra },
});

const carousel = (id: string, slides: unknown[]) => ({
  id,
  type: 'carousel',
  v: 1,
  props: { slides },
});

const slide = { image: 'https://cdn.example.com/banner.jpg' };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error('expected a DomainError, got success');
}

let sequence = 0;

async function product(
  values: Partial<typeof products.$inferInsert> = {},
  links: { categoryId?: number; labelId?: number } = {},
): Promise<string> {
  sequence += 1;
  const [row] = await ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 50,
      freightMode: 'free',
      unitName: '件',
      ...values,
    })
    .returning({ id: products.id });
  if (links.categoryId !== undefined) {
    await ctx.db
      .insert(productCategoriesMap)
      .values({ productId: row!.id, categoryId: links.categoryId });
  }
  if (links.labelId !== undefined) {
    await ctx.db.insert(productLabelsMap).values({ productId: row!.id, labelId: links.labelId });
  }
  return String(row!.id);
}

async function productCategory(name: string): Promise<number> {
  const [row] = await ctx.db
    .insert(productCategories)
    .values({ name, path: '/', level: 0 })
    .returning({ id: productCategories.id });
  return row!.id;
}

async function productLabel(name: string): Promise<number> {
  const [group] = await ctx.db
    .insert(productLabelCategories)
    .values({ name: `${name}组` })
    .returning({ id: productLabelCategories.id });
  const [row] = await ctx.db
    .insert(productLabels)
    .values({ categoryId: group!.id, name, isEnabled: true })
    .returning({ id: productLabels.id });
  return row!.id;
}

async function template(
  values: Partial<typeof couponTemplates.$inferInsert> = {},
): Promise<string> {
  sequence += 1;
  const [row] = await ctx.db
    .insert(couponTemplates)
    .values({
      name: `券${sequence}`,
      scope: 'all_products',
      claimMode: 'manual',
      status: 'active',
      discountAmount: '10.00',
      minSpend: '100.00',
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: false,
      totalCount: 100,
      remainingCount: 100,
      perUserLimit: 1,
      ...values,
    })
    .returning({ id: couponTemplates.id });
  return String(row!.id);
}

async function article(values: Partial<typeof articles.$inferInsert> = {}): Promise<string> {
  sequence += 1;
  const [row] = await ctx.db
    .insert(articles)
    .values({
      title: `文章${sequence}`,
      status: 'published',
      publishedAt: new Date('2026-05-01T00:00:00.000Z'),
      ...values,
    })
    .returning({ id: articles.id });
  return String(row!.id);
}

async function user(account: string): Promise<number> {
  const [row] = await ctx.db.insert(users).values({ account }).returning({ id: users.id });
  return row!.id;
}

/** Creates a document, saves `blocks` as its draft and returns it (unpublished). */
async function drafted(
  kind: 'home' | 'user_center' | 'custom',
  blocks: unknown[],
  name = '页面',
): Promise<{ id: string; version: string }> {
  const created = await decor.createDocument(ctx, { kind, name });
  const saved = await decor.saveDraft(ctx, {
    id: created.id,
    document: doc(blocks),
    version: created.draftVersion,
  });
  return { id: created.id, version: saved.version };
}

/** A published document; designated when `designation` is given. */
async function live(
  kind: 'home' | 'user_center' | 'custom',
  blocks: unknown[],
  designation?: 'home' | 'user_center',
): Promise<string> {
  const { id } = await drafted(kind, blocks);
  await decor.publish(ctx, { id, note: '' });
  if (designation) await decor.designate(ctx, { designation, documentId: id });
  return id;
}

async function revisionCount(documentId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: decorRevisions.id })
    .from(decorRevisions)
    .where(eq(decorRevisions.documentId, Number(documentId)));
  return rows.length;
}

// ---------------------------------------------------------------------------
// documents and drafts
// ---------------------------------------------------------------------------

describe('decor documents — DECOR-003', () => {
  it('DECOR-003: a new page starts empty and titled after its name; a new 个人中心 starts from the built-in one', async () => {
    const page = await decor.createDocument(ctx, { kind: 'custom', name: '618 活动页' });
    expect(page.draft.blocks).toEqual([]);
    expect(page.draft.root.props.title).toBe('618 活动页');
    expect(page.draftVersion).toBe('1');
    expect(page.published).toBeNull();
    expect(page.hasUnpublishedChanges).toBe(true);

    const center = await decor.createDocument(ctx, { kind: 'user_center', name: '个人中心' });
    expect(center.draft.blocks.map((block) => block.type)).toEqual([
      'userCard',
      'orderEntry',
      'serviceGrid',
    ]);
    expect(center.issues).toEqual([]);
  });

  it('DECOR-003: a draft with content issues is saved and the issues reported; a broken envelope is refused', async () => {
    const created = await decor.createDocument(ctx, { kind: 'home', name: '首页' });
    const saved = await decor.saveDraft(ctx, {
      id: created.id,
      document: doc([carousel('banner', [])]),
      version: created.draftVersion,
    });
    expect(saved.version).toBe('2');
    expect(saved.issues.map((issue) => issue.path)).toContain('blocks.0.props.slides');

    const reread = await decor.getDocument(ctx, { id: created.id });
    expect(reread.draft.blocks).toHaveLength(1);
    expect(reread.issues).toEqual(saved.issues);

    expect(
      await codeOf(
        decor.saveDraft(ctx, {
          id: created.id,
          document: { schemaVersion: 1, root: { props: {} }, blocks: [] },
          version: saved.version,
        }),
      ),
    ).toBe('DECOR_DOCUMENT_INVALID');
    // The refused save changed nothing.
    expect((await decor.getDocument(ctx, { id: created.id })).draftVersion).toBe('2');
  });

  it('DECOR-003: an unknown block type is kept as it came, with a warning', async () => {
    const future = { id: 'f1', type: 'liveStream', v: 3, props: { roomId: 'abc' } };
    const created = await decor.createDocument(ctx, { kind: 'custom', name: '页' });
    const saved = await decor.saveDraft(ctx, {
      id: created.id,
      document: doc([future]),
      version: created.draftVersion,
    });
    expect(saved.warnings.map((warning) => warning.path)).toContain('blocks.0.type');
    expect(saved.issues.map((issue) => issue.path)).toContain('blocks.0.type');
    const reread = await decor.getDocument(ctx, { id: created.id });
    expect(reread.draft.blocks[0]).toEqual(future);
  });

  it('DECOR-003: a known block is stored migrated, with its defaults filled in', async () => {
    const { id } = await drafted('custom', [grid('g', { mode: 'manual', ids: [] })]);
    const reread = await decor.getDocument(ctx, { id });
    expect(reread.draft.blocks[0]!.props).toMatchObject({
      titleLines: 2,
      style: { marginY: 'none' },
      visibility: { audience: 'all', platforms: [] },
    });
  });

  it('DECOR-003: lists, renames, duplicates and soft-deletes documents', async () => {
    const a = await decor.createDocument(ctx, { kind: 'custom', name: '甲页' });
    await decor.createDocument(ctx, { kind: 'home', name: '乙首页' });

    const customs = await decor.listDocuments(ctx, { page: 1, pageSize: 20, kind: 'custom' });
    expect(customs.items.map((item) => item.name)).toEqual(['甲页']);
    const byKeyword = await decor.listDocuments(ctx, { page: 1, pageSize: 20, keyword: '首' });
    expect(byKeyword.total).toBe(1);

    const renamed = await decor.renameDocument(ctx, { id: a.id, name: '甲页改' });
    expect(renamed.name).toBe('甲页改');

    const copy = await decor.duplicateDocument(ctx, { id: a.id });
    expect(copy.name).toBe('甲页改 副本');
    expect(copy.kind).toBe('custom');
    expect(copy.published).toBeNull();
    expect(copy.draft).toEqual(a.draft);

    await decor.deleteDocument(ctx, { id: a.id });
    expect(await codeOf(decor.getDocument(ctx, { id: a.id }))).toBe('DECOR_DOCUMENT_NOT_FOUND');
    expect(await codeOf(decor.deleteDocument(ctx, { id: a.id }))).toBe('DECOR_DOCUMENT_NOT_FOUND');
    expect((await decor.listDocuments(ctx, { page: 1, pageSize: 20 })).total).toBe(2);
  });
});

describe('draft saves — DECOR-010', () => {
  it('DECOR-010: a save on a stale version is refused with the current version, and changes nothing', async () => {
    const { id, version } = await drafted('custom', []);
    const stale = String(Number(version) - 1);
    const error = await decor
      .saveDraft(ctx, { id, document: doc([carousel('b', [slide])]), version: stale })
      .catch((caught: unknown) => caught as { code: string; details: unknown });
    expect(error).toMatchObject({ code: 'DECOR_VERSION_CONFLICT', details: { version } });
    const reread = await decor.getDocument(ctx, { id });
    expect(reread.draftVersion).toBe(version);
    expect(reread.draft.blocks).toEqual([]);
  });

  it('DECOR-010: a save on a deleted document is not found, not a conflict', async () => {
    const { id, version } = await drafted('custom', []);
    await decor.deleteDocument(ctx, { id });
    expect(await codeOf(decor.saveDraft(ctx, { id, document: doc([]), version }))).toBe(
      'DECOR_DOCUMENT_NOT_FOUND',
    );
  });
});

describe('references — DECOR-004', () => {
  it('DECOR-004: a record the shopper cannot see is a warning on save, never an error', async () => {
    const onShelf = await product();
    const offShelf = await product({ status: 'off_shelf' });
    const created = await decor.createDocument(ctx, { kind: 'custom', name: '页' });
    const saved = await decor.saveDraft(ctx, {
      id: created.id,
      document: doc([
        grid('g', { mode: 'manual', ids: [onShelf, offShelf] }),
        carousel('c', [{ ...slide, link: { kind: 'page', id: '999' } }]),
      ]),
      version: created.draftVersion,
    });
    expect(saved.issues).toEqual([]);
    expect(saved.warnings.map((warning) => warning.path).sort()).toEqual(
      ['blocks.0.props.source.ids.1', 'blocks.1.props.slides.0.link'].sort(),
    );
    // Warnings do not block publishing.
    const published = await decor.publish(ctx, { id: created.id, note: '' });
    expect(published.revision.number).toBe(1);
    expect(published.warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// publishing, revisions, rollback
// ---------------------------------------------------------------------------

describe('publishing — DECOR-007', () => {
  it('DECOR-007: publish writes revision 1 and moves the live pointer; the same draft again is nothing to publish', async () => {
    const { id, version } = await drafted('custom', [carousel('b', [slide])]);
    const published = await decor.publish(ctx, { id, version, note: '首发' });
    expect(published.revision).toMatchObject({ number: 1, note: '首发', authorAdminId: '1' });
    expect(published.document.published?.number).toBe(1);
    expect(published.document.hasUnpublishedChanges).toBe(false);

    expect(await codeOf(decor.publish(ctx, { id, note: '' }))).toBe('DECOR_NOTHING_TO_PUBLISH');
    expect(await revisionCount(id)).toBe(1);

    const saved = await decor.saveDraft(ctx, {
      id,
      document: doc([carousel('b', [slide, slide])]),
      version,
    });
    expect((await decor.getDocument(ctx, { id })).hasUnpublishedChanges).toBe(true);
    const second = await decor.publish(ctx, { id, version: saved.version, note: '' });
    expect(second.revision.number).toBe(2);
    const revisions = await decor.listRevisions(ctx, { id });
    expect(revisions.items.map((item) => item.number)).toEqual([2, 1]);
  });

  it('DECOR-007: a draft with issues is not published, and nothing is written', async () => {
    const { id } = await drafted('custom', [carousel('b', [])]);
    const error = (await decor.publish(ctx, { id, note: '' }).then(
      () => null,
      (caught: unknown) => caught,
    )) as { code: string; details: { issues: unknown[] } };
    expect(error.code).toBe('DECOR_DOCUMENT_INVALID');
    expect(error.details.issues.length).toBeGreaterThan(0);
    expect(await revisionCount(id)).toBe(0);
    expect((await decor.getDocument(ctx, { id })).published).toBeNull();
  });

  it('DECOR-007: a block not allowed on the page kind blocks publishing', async () => {
    const { id } = await drafted('home', [{ id: 'u', type: 'userCard', v: 1, props: {} }]);
    expect(await codeOf(decor.publish(ctx, { id, note: '' }))).toBe('DECOR_DOCUMENT_INVALID');
  });

  it('DECOR-007: publishing a version other than the draft is a conflict', async () => {
    const { id, version } = await drafted('custom', []);
    expect(
      await codeOf(decor.publish(ctx, { id, version: String(Number(version) + 1), note: '' })),
    ).toBe('DECOR_VERSION_CONFLICT');
    expect(await revisionCount(id)).toBe(0);
  });
});

describe('revisions — DECOR-006', () => {
  it('DECOR-006: the database refuses to update or delete a revision', async () => {
    const id = await live('custom', []);
    const pool = harness.db.handle.pool;
    await expect(pool.query(`update decor_revisions set note = 'x'`)).rejects.toMatchObject({
      code: '23001',
    });
    await expect(pool.query(`delete from decor_revisions`)).rejects.toMatchObject({
      code: '23001',
    });
    expect(await revisionCount(id)).toBe(1);
  });

  it('DECOR-006: a revision is read back exactly as published', async () => {
    const id = await live('custom', [carousel('b', [slide])]);
    const revision = await decor.getRevision(ctx, { id, number: 1 });
    expect(revision.content.blocks.map((block) => block.id)).toEqual(['b']);
    expect(await codeOf(decor.getRevision(ctx, { id, number: 2 }))).toBe(
      'DECOR_REVISION_NOT_FOUND',
    );
  });
});

describe('rollback — DECOR-011', () => {
  it('DECOR-011: rollback republishes old content as a new revision and leaves the draft alone', async () => {
    const { id, version } = await drafted('custom', [carousel('one', [slide])]);
    await decor.publish(ctx, { id, note: '' });
    const saved = await decor.saveDraft(ctx, {
      id,
      document: doc([carousel('two', [slide])]),
      version,
    });
    await decor.publish(ctx, { id, note: '' });

    const rolled = await decor.rollback(ctx, { id, number: 1, note: '回滚' });
    expect(rolled.revision).toMatchObject({ number: 3, restoredFrom: 1, note: '回滚' });
    expect(rolled.document.published?.number).toBe(3);
    // The draft still holds revision 2's content, now unpublished.
    expect(rolled.document.hasUnpublishedChanges).toBe(true);
    const detail = await decor.getDocument(ctx, { id });
    expect(detail.draftVersion).toBe(saved.version);
    expect(detail.draft.blocks.map((block) => block.id)).toEqual(['two']);

    const restored = await decor.getRevision(ctx, { id, number: 3 });
    const original = await decor.getRevision(ctx, { id, number: 1 });
    expect(restored.content).toEqual(original.content);
    expect(await revisionCount(id)).toBe(3);

    // The draft is unpublished again, so publishing it is allowed.
    expect((await decor.publish(ctx, { id, note: '' })).revision.number).toBe(4);
  });

  it('DECOR-011: rolling back to a revision that does not exist writes nothing', async () => {
    const id = await live('custom', []);
    expect(await codeOf(decor.rollback(ctx, { id, number: 7, note: '' }))).toBe(
      'DECOR_REVISION_NOT_FOUND',
    );
    expect(await revisionCount(id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// designations and deletion
// ---------------------------------------------------------------------------

describe('designations — DECOR-008', () => {
  it('DECOR-008: only a published document of the matching kind can be designated', async () => {
    const custom = await live('custom', []);
    expect(await codeOf(decor.designate(ctx, { designation: 'home', documentId: custom }))).toBe(
      'DECOR_KIND_MISMATCH',
    );
    const unpublished = await drafted('home', []);
    expect(
      await codeOf(decor.designate(ctx, { designation: 'home', documentId: unpublished.id })),
    ).toBe('DECOR_NOT_PUBLISHED');
    expect(await codeOf(decor.designate(ctx, { designation: 'home', documentId: '999' }))).toBe(
      'DECOR_DOCUMENT_NOT_FOUND',
    );
    expect(await decor.getDesignations(ctx)).toEqual({ home: null, user_center: null });
  });

  it('DECOR-008: designating another document moves the designation; null clears it', async () => {
    const first = await live('home', [], 'home');
    const second = await live('home', []);
    expect((await decor.getDesignations(ctx)).home?.id).toBe(first);

    const moved = await decor.designate(ctx, { designation: 'home', documentId: second });
    expect(moved.home?.id).toBe(second);
    expect(moved.home?.designation).toBe('home');
    expect((await decor.getDocument(ctx, { id: first })).designation).toBeNull();

    // Designating the current one again is a no-op.
    expect((await decor.designate(ctx, { designation: 'home', documentId: second })).home?.id).toBe(
      second,
    );

    const cleared = await decor.designate(ctx, { designation: 'home', documentId: null });
    expect(cleared.home).toBeNull();
    const rows = await ctx.db
      .select({ id: decorDocuments.id })
      .from(decorDocuments)
      .where(eq(decorDocuments.designation, 'home'));
    expect(rows).toEqual([]);
  });

  it('DECOR-008: the database allows one document per designation', async () => {
    await live('home', [], 'home');
    const other = await live('home', []);
    await expect(
      ctx.db
        .update(decorDocuments)
        .set({ designation: 'home' })
        .where(eq(decorDocuments.id, Number(other))),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('deletion — DECOR-009', () => {
  it('DECOR-009: the designated document cannot be deleted; once undesignated it can', async () => {
    const id = await live('home', [], 'home');
    expect(await codeOf(decor.deleteDocument(ctx, { id }))).toBe('DECOR_DOCUMENT_IN_USE');
    expect((await decor.getDocument(ctx, { id })).designation).toBe('home');

    await decor.designate(ctx, { designation: 'home', documentId: null });
    await decor.deleteDocument(ctx, { id });
    expect(await codeOf(decor.getDocument(ctx, { id }))).toBe('DECOR_DOCUMENT_NOT_FOUND');
    // Its revisions stay: they are history.
    expect(await revisionCount(id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// preview tokens
// ---------------------------------------------------------------------------

describe('preview tokens — DECOR-012', () => {
  it('DECOR-012: a token opens the draft of its own document, uncached and marked preview', async () => {
    const id = await live('custom', [carousel('old', [slide])]);
    const detail = await decor.getDocument(ctx, { id });
    await decor.saveDraft(ctx, {
      id,
      document: doc([carousel('new', [slide])]),
      version: detail.draftVersion,
    });
    const { previewToken, expiresAt } = await decor.createPreviewToken(ctx, { id });
    expect(new Date(expiresAt).getTime() - new Date(NOW).getTime()).toBe(
      decor.PREVIEW_TOKEN_SECONDS * 1000,
    );

    const page = await decor.resolveDocument(anonymous(), { id, previewToken, ...NO_CLIENT });
    expect(page).toMatchObject({ preview: true, revision: null, version: `draft-${id}-3` });
    expect(page.blocks.map((block) => block.id)).toEqual(['new']);

    const published = await decor.resolveDocument(anonymous(), { id, ...NO_CLIENT });
    expect(published.blocks.map((block) => block.id)).toEqual(['old']);
    expect(published.preview).toBe(false);
  });

  it('DECOR-012: a token does not open another document, and a made-up token opens nothing', async () => {
    const mine = await drafted('custom', []);
    const other = await drafted('custom', []);
    const { previewToken } = await decor.createPreviewToken(ctx, { id: mine.id });
    expect(
      await codeOf(
        decor.resolveDocument(anonymous(), { id: other.id, previewToken, ...NO_CLIENT }),
      ),
    ).toBe('DECOR_PREVIEW_TOKEN_INVALID');
    expect(
      await codeOf(
        decor.resolveDocument(anonymous(), {
          id: mine.id,
          previewToken: 'x'.repeat(43),
          ...NO_CLIENT,
        }),
      ),
    ).toBe('DECOR_PREVIEW_TOKEN_INVALID');
    // Without a token, an unpublished document does not exist for the storefront.
    expect(await codeOf(decor.resolveDocument(anonymous(), { id: mine.id, ...NO_CLIENT }))).toBe(
      'DECOR_DOCUMENT_NOT_FOUND',
    );
  });

  it('DECOR-012: the token expires with Redis and is stored only as a hash', async () => {
    const { id } = await drafted('custom', []);
    const { previewToken } = await decor.createPreviewToken(ctx, { id });
    const keys = await harness.redis.keys('decor:preview:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(previewToken);
    expect(await harness.redis.get(keys[0]!)).toBe(id);
    const ttl = await harness.redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(decor.PREVIEW_TOKEN_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(decor.PREVIEW_TOKEN_SECONDS);

    await harness.redis.del(keys[0]!); // what the TTL does
    expect(
      await codeOf(decor.resolveDocument(anonymous(), { id, previewToken, ...NO_CLIENT })),
    ).toBe('DECOR_PREVIEW_TOKEN_INVALID');
  });
});

// ---------------------------------------------------------------------------
// the resolver
// ---------------------------------------------------------------------------

/** Test-only blocks for the data kinds no shipped block uses yet. */
const testCoupons = defineBlock({
  type: 'testCoupons',
  v: 1,
  props: blockProps({ source: couponSource.default({ mode: 'auto', limit: 3 }) }),
  meta: { label: '测试券', pages: ['home', 'custom', 'user_center'] },
  data: (props) => ({ coupons: need.coupons(props.source) }),
});
const testNewUser = defineBlock({
  type: 'testNewUser',
  v: 1,
  props: blockProps({}),
  meta: { label: '测试新人券', pages: ['home', 'custom', 'user_center'] },
  data: () => ({ coupons: need.newUserCoupons(3) }),
});
const testArticles = defineBlock({
  type: 'testArticles',
  v: 1,
  props: blockProps({ source: articleSource.default({ mode: 'manual', ids: [] }) }),
  meta: { label: '测试资讯', pages: ['home', 'custom', 'user_center'] },
  data: (props) => ({ articles: need.articles(props.source) }),
});
const testCampaigns = defineBlock({
  type: 'testCampaigns',
  v: 1,
  props: blockProps({}),
  meta: { label: '测试活动', pages: ['home', 'custom', 'user_center'] },
  data: () => ({
    groupbuys: need.groupbuys({ mode: 'auto', limit: 3 }),
    presales: need.presales({ mode: 'auto', limit: 3 }),
  }),
});
const testFresh = defineBlock({
  type: 'testFresh',
  v: 1,
  props: blockProps({}),
  meta: { label: '新组件', pages: ['home', 'custom', 'user_center'], minClient: '2.0.0' },
});
const testRegistry = createBlockRegistry([
  ...decorBlocks.list(),
  testCoupons,
  testNewUser,
  testArticles,
  testCampaigns,
  testFresh,
]);

/** The draft of a new custom page with `blocks`, resolved through a preview token. */
async function previewOf(
  blocks: unknown[],
  as: Ctx = anonymous(),
  options: decor.ResolveOptions = { registry: testRegistry },
  clientVersion: string | null = null,
) {
  const { id } = await drafted('custom', blocks);
  const { previewToken } = await decor.createPreviewToken(ctx, { id });
  return decor.resolveDocument(as, { id, previewToken, clientVersion }, options);
}

type Summary = { id: string; title?: string; soldOut?: boolean; templateId?: string };
const idsIn = (
  page: { blocks: { data: Record<string, unknown> }[] },
  index: number,
  slot: string,
) =>
  ((page.blocks[index]!.data[slot] ?? []) as Summary[]).map((item) => item.templateId ?? item.id);

describe('resolved data — DECOR-013', () => {
  it('DECOR-013: a manual product list keeps the operator order, skips what is off the shelf and marks what is sold out', async () => {
    const a = await product({ name: '甲' });
    const off = await product({ status: 'off_shelf' });
    const soldOut = await product({ stock: 0 });
    const b = await product({ name: '乙', originalPrice: '80.00' });
    await live('home', [grid('g', { mode: 'manual', ids: [b, off, soldOut, a] })], 'home');

    const page = await decor.resolveHome(anonymous(), NO_CLIENT);
    const items = page.blocks[0]!.data.products as Summary[];
    expect(items.map((item) => item.id)).toEqual([b, soldOut, a]);
    expect(items[0]).toMatchObject({ title: '乙', price: '60.00', marketPrice: '80.00' });
    expect(items[1]).toMatchObject({ soldOut: true });
    expect(items[2]).not.toHaveProperty('soldOut');
  });

  it('DECOR-013: a category or label rule returns on-shelf products with stock only, at most the limit', async () => {
    const category = await productCategory('女装');
    const label = await productLabel('新品');
    const inCategory = [
      await product({ price: '10.00' }, { categoryId: category }),
      await product({ price: '30.00' }, { categoryId: category }),
      await product({ price: '20.00' }, { categoryId: category }),
    ];
    await product({ stock: 0 }, { categoryId: category });
    await product({ status: 'off_shelf' }, { categoryId: category });
    const labelled = await product({}, { labelId: label });
    await product({ stock: 0 }, { labelId: label });

    await live(
      'home',
      [
        grid('byCategory', {
          mode: 'category',
          categoryId: String(category),
          sort: 'priceAsc',
          limit: 2,
        }),
        grid('byLabel', { mode: 'label', labelId: String(label), sort: 'default', limit: 6 }),
      ],
      'home',
    );
    const page = await decor.resolveHome(anonymous(), NO_CLIENT);
    expect(idsIn(page, 0, 'products')).toEqual([inCategory[0], inCategory[2]]);
    expect(idsIn(page, 1, 'products')).toEqual([labelled]);
    expect((page.blocks[1]!.data.products as { tag?: string }[])[0]!.tag).toBe('新品');
  });

  it('DECOR-013: coupons, 新人券 and articles come back only when the shopper could see them', async () => {
    const claimable = await template();
    await template({ status: 'disabled' });
    await template({ claimMode: 'new_user' });
    const newUser = await template({ claimMode: 'new_user', name: '新人券' });
    const published = await article();
    const draft = await article({ status: 'draft', publishedAt: null });

    const page = await previewOf([
      { id: 'c', type: 'testCoupons', v: 1, props: { source: { mode: 'auto', limit: 5 } } },
      { id: 'n', type: 'testNewUser', v: 1, props: {} },
      {
        id: 'a',
        type: 'testArticles',
        v: 1,
        props: { source: { mode: 'manual', ids: [draft, published] } },
      },
      { id: 'k', type: 'testCampaigns', v: 1, props: {} },
    ]);
    expect(idsIn(page, 0, 'coupons')).toEqual([claimable]);
    expect(idsIn(page, 1, 'coupons')).toContain(newUser);
    expect(idsIn(page, 1, 'coupons')).not.toContain(claimable);
    expect(idsIn(page, 2, 'articles')).toEqual([published]);
    expect(page.blocks[3]!.data).toEqual({ groupbuys: [], presales: [] });
    // The per-shopper fields never travel in the public data.
    expect(page.blocks[0]!.data.coupons![0]).not.toHaveProperty('canClaim');
    expect(page.personal).toBeNull();
  });

  it('DECOR-013: a resolver that fails costs its slot, not the page', async () => {
    const a = await product();
    const page = await previewOf(
      [grid('g', { mode: 'manual', ids: [a] }), carousel('c', [slide])],
      anonymous(),
      {
        registry: testRegistry,
        resolvers: {
          products: () => Promise.reject(new Error('catalog down')),
        },
      },
    );
    expect(page.blocks.map((block) => block.id)).toEqual(['g', 'c']);
    expect(page.blocks[0]!.data).toEqual({ products: null });
  });
});

describe('page cache — DECOR-014', () => {
  it('DECOR-014: the public page is cached per revision, and a publish serves the new revision at once', async () => {
    const a = await product({ name: '原名' });
    const id = await live('home', [grid('g', { mode: 'manual', ids: [a] })], 'home');
    const first = await decor.resolveHome(anonymous(), NO_CLIENT);
    const revisionId = Number(first.version.replace('rev-', ''));
    expect(await harness.redis.ttl(decor.revisionCacheKey(revisionId))).toBeGreaterThan(0);

    // Data changes without a publish show once the short TTL runs out, not before.
    await ctx.db
      .update(products)
      .set({ name: '新名' })
      .where(eq(products.id, Number(a)));
    const cached = await decor.resolveHome(anonymous(), NO_CLIENT);
    expect((cached.blocks[0]!.data.products as Summary[])[0]!.title).toBe('原名');
    expect(cached.resolvedAt).toBe(first.resolvedAt);

    const detail = await decor.getDocument(ctx, { id });
    await decor.saveDraft(ctx, {
      id,
      document: doc([grid('g', { mode: 'manual', ids: [a] }), carousel('c', [slide])]),
      version: detail.draftVersion,
    });
    await decor.publish(ctx, { id, note: '' });
    expect(await harness.redis.exists(decor.revisionCacheKey(revisionId))).toBe(0);

    const next = await decor.resolveHome(anonymous(), NO_CLIENT);
    expect(next.version).not.toBe(first.version);
    expect(next.revision).toBe(2);
    expect(next.blocks.map((block) => block.id)).toEqual(['g', 'c']);
    expect((next.blocks[0]!.data.products as Summary[])[0]!.title).toBe('新名');
  });

  it('DECOR-014: a rollback also moves the page off the cached revision', async () => {
    const { id, version } = await drafted('home', [carousel('one', [slide])]);
    await decor.publish(ctx, { id, note: '' });
    await decor.designate(ctx, { designation: 'home', documentId: id });
    await decor.saveDraft(ctx, { id, document: doc([carousel('two', [slide])]), version });
    await decor.publish(ctx, { id, note: '' });
    expect((await decor.resolveHome(anonymous(), NO_CLIENT)).blocks[0]!.id).toBe('two');

    await decor.rollback(ctx, { id, number: 1, note: '' });
    const page = await decor.resolveHome(anonymous(), NO_CLIENT);
    expect(page.revision).toBe(3);
    expect(page.blocks[0]!.id).toBe('one');
  });

  it('DECOR-014: no home designated is DECOR_HOME_NOT_SET', async () => {
    await live('home', []);
    expect(await codeOf(decor.resolveHome(anonymous(), NO_CLIENT))).toBe('DECOR_HOME_NOT_SET');
  });
});

describe('per-shopper state — DECOR-015', () => {
  it('DECOR-015: with a session the page carries the coupon state of that shopper; without one, none', async () => {
    const uid = await user('shopper-1');
    const claimable = await template({ perUserLimit: 2 });
    const blocks = [
      {
        id: 'c',
        type: 'testCoupons',
        v: 1,
        props: { source: { mode: 'manual', ids: [claimable] } },
      },
    ];
    const signedIn = harness.as(shopper(uid));
    await coupon.claim(signedIn, { id: claimable });

    const page = await previewOf(blocks, signedIn);
    expect(page.personal).toEqual({
      c: {
        coupons: {
          kind: 'coupons',
          items: [{ templateId: claimable, claimedCount: 1, canClaim: true }],
        },
      },
    });
    expect((await previewOf(blocks, anonymous())).personal).toBeNull();
    // An admin session is not a shopper.
    expect((await previewOf(blocks, ctx)).personal).toBeNull();
  });

  it('DECOR-015: the cached public page holds nothing per shopper', async () => {
    const uid = await user('shopper-2');
    const a = await product();
    await live('home', [grid('g', { mode: 'manual', ids: [a] })], 'home');
    const page = await decor.resolveHome(harness.as(shopper(uid)), NO_CLIENT);
    expect(page.personal).toEqual({});
    const raw = await harness.redis.get(decor.revisionCacheKey(Number(page.version.slice(4))));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).not.toHaveProperty('personal');
  });
});

describe('per-request filtering — DECOR-016', () => {
  const audience = (id: string, value: string, platforms: string[] = []) => ({
    ...carousel(id, [slide]),
    props: { slides: [slide], visibility: { audience: value, platforms } },
  });

  it('DECOR-016: blocks are filtered by audience and X-Client-Platform, per request, from one cached page', async () => {
    const uid = await user('shopper-3');
    await live(
      'home',
      [
        audience('everyone', 'all'),
        audience('guests', 'guest'),
        audience('members', 'member'),
        audience('miniOnly', 'all', ['wechat-mini']),
      ],
      'home',
    );
    const ids = (page: { blocks: { id: string }[] }) => page.blocks.map((block) => block.id);

    expect(ids(await decor.resolveHome(anonymous(), NO_CLIENT))).toEqual([
      'everyone',
      'guests',
      'miniOnly',
    ]);
    const h5Guest = forkTestCtx(harness, { actor: anonymousActor, platform: 'h5' });
    expect(ids(await decor.resolveHome(h5Guest, NO_CLIENT))).toEqual(['everyone', 'guests']);
    const miniMember = forkTestCtx(harness, { actor: shopper(uid), platform: 'wechat-mini' });
    expect(ids(await decor.resolveHome(miniMember, NO_CLIENT))).toEqual([
      'everyone',
      'members',
      'miniOnly',
    ]);
  });

  it('DECOR-016: a block type newer than the client is left out for that client only', async () => {
    const blocks = [carousel('c', [slide]), { id: 'fresh', type: 'testFresh', v: 1, props: {} }];
    const ids = async (clientVersion: string | null) =>
      (await previewOf(blocks, anonymous(), { registry: testRegistry }, clientVersion)).blocks.map(
        (block) => block.id,
      );
    expect(await ids('1.9.9')).toEqual(['c']);
    expect(await ids('2.0.0')).toEqual(['c', 'fresh']);
    expect(await ids('10.0.0')).toEqual(['c', 'fresh']);
    expect(await ids(null)).toEqual(['c', 'fresh']);
  });

  it('DECOR-016: unknown, newer-than-this-build and unparseable blocks are skipped, never served broken', async () => {
    const page = await previewOf([
      { id: 'unknown', type: 'liveStream', v: 1, props: {} },
      { id: 'newer', type: 'carousel', v: 9, props: { slides: [slide] } },
      carousel('broken', []),
      carousel('ok', [slide]),
    ]);
    expect(page.blocks.map((block) => block.id)).toEqual(['ok']);
    expect(page.blocks[0]!.props).toMatchObject({ height: 340, visibility: { audience: 'all' } });
  });

  it('DECOR-016: blockVisibleTo ignores a client version it cannot read', () => {
    const block = { type: 'testFresh', props: { visibility: { audience: 'all', platforms: [] } } };
    const caller = { signedIn: false, platform: null, clientVersion: 'beta' };
    expect(decor.blockVisibleTo(block, caller, testRegistry)).toBe(true);
    expect(decor.blockVisibleTo(block, { ...caller, clientVersion: '1.0.0' }, testRegistry)).toBe(
      false,
    );
  });
});

describe('the built-in 个人中心 — DECOR-005', () => {
  it('DECOR-005: with nothing designated the storefront gets the built-in 个人中心; once designated, that one', async () => {
    const builtin = await decor.resolveUserCenter(anonymous(), NO_CLIENT);
    expect(builtin).toMatchObject({
      id: null,
      kind: 'user_center',
      revision: null,
      version: USER_CENTER_DEFAULT_VERSION,
    });
    expect(builtin.blocks.map((block) => block.type)).toEqual([
      'userCard',
      'orderEntry',
      'serviceGrid',
    ]);

    const created = await decor.createDocument(ctx, { kind: 'user_center', name: '我的' });
    const detail = await decor.getDocument(ctx, { id: created.id });
    await decor.saveDraft(ctx, {
      id: created.id,
      document: { ...detail.draft, blocks: detail.draft.blocks.slice(0, 2) },
      version: detail.draftVersion,
    });
    await decor.publish(ctx, { id: created.id, note: '' });
    await decor.designate(ctx, { designation: 'user_center', documentId: created.id });

    const designated = await decor.resolveUserCenter(anonymous(), NO_CLIENT);
    expect(designated).toMatchObject({ id: created.id, revision: 1 });
    expect(designated.blocks.map((block) => block.type)).toEqual(['userCard', 'orderEntry']);

    await decor.designate(ctx, { designation: 'user_center', documentId: null });
    expect((await decor.resolveUserCenter(anonymous(), NO_CLIENT)).version).toBe(
      USER_CENTER_DEFAULT_VERSION,
    );
  });
});

describe('the batch-1 blocks (G1)', () => {
  /** Writes `blocks` straight into a draft row, past `saveDraft`, as an old build might have. */
  async function rawPreview(blocks: unknown[], as: Ctx = anonymous()) {
    const { id } = await drafted('custom', []);
    await ctx.db
      .update(decorDocuments)
      .set({ draft: doc(blocks) })
      .where(eq(decorDocuments.id, Number(id)));
    const { previewToken } = await decor.createPreviewToken(ctx, { id });
    return decor.resolveDocument(as, { id, previewToken, clientVersion: null });
  }

  it('DECOR-003: a 商品网格 stored at v1 is served at v2 as the two-column grid it was, with its products', async () => {
    const a = await product({ name: '甲' });
    const page = await rawPreview([
      {
        id: 'old',
        type: 'productGrid',
        v: 1,
        props: { source: { mode: 'manual', ids: [a] }, titleLines: 1, showTag: false },
      },
    ]);
    expect(page.blocks[0]).toMatchObject({
      id: 'old',
      v: 2,
      props: { layout: 'grid2', titleLines: 1, showTag: false, showMarketPrice: true },
    });
    expect(idsIn(page, 0, 'products')).toEqual([a]);
  });

  it('DECOR-003: a draft stored before a block’s upgrade opens migrated, so the editor can load it', async () => {
    const { id } = await drafted('custom', []);
    const v1 = { source: { mode: 'manual', ids: [] }, titleLines: 1, showTag: false };
    await ctx.db
      .update(decorDocuments)
      .set({ draft: doc([{ id: 'old', type: 'productGrid', v: 1, props: v1 }]) })
      .where(eq(decorDocuments.id, Number(id)));
    const detail = await decor.getDocument(ctx, { id });
    expect(detail.issues).toEqual([]);
    expect(detail.draft.blocks[0]).toMatchObject({
      id: 'old',
      type: 'productGrid',
      v: 2,
      props: { ...v1, layout: 'grid2' },
    });
  });

  it('DECOR-017: rich text is stored sanitised, and served sanitised even when the row was not', async () => {
    const dirty =
      '<p onclick="steal()">须知</p><script>alert(1)</script><iframe src="https://x.example"></iframe>' +
      '<img src="javascript:alert(1)"><img src="https://cdn.example.com/a.jpg" style="width:9999px">';
    const clean =
      '<p>须知</p><img src="https://cdn.example.com/a.jpg" style="max-width:100%;height:auto;display:block">';

    const { id } = await drafted('custom', [
      { id: 'r', type: 'richText', v: 1, props: { html: dirty } },
    ]);
    expect((await decor.getDocument(ctx, { id })).draft.blocks[0]!.props.html).toBe(clean);

    const page = await rawPreview([{ id: 'r', type: 'richText', v: 1, props: { html: dirty } }]);
    expect(page.blocks[0]!.props.html).toBe(clean);
  });

  it('DECOR-013: a 商品选项卡 resolves every tab’s products with the page, each by its own rule', async () => {
    const category = await productCategory('新品');
    const inCategory = await product({}, { categoryId: category });
    const picked = await product();
    const page = await previewOf([
      {
        id: 't',
        type: 'productTabs',
        v: 1,
        props: {
          tabs: [
            { title: '新品', source: { mode: 'category', categoryId: String(category), limit: 4 } },
            { title: '精选', source: { mode: 'manual', ids: [picked] } },
            { title: '空', source: { mode: 'manual', ids: [] } },
          ],
        },
      },
    ]);
    expect(idsIn(page, 0, 'tab0')).toEqual([inCategory]);
    expect(idsIn(page, 0, 'tab1')).toEqual([picked]);
    expect(page.blocks[0]!.data.tab2).toEqual([]);
  });

  describe('per-shopper state of the 个人中心 blocks — DECOR-015', () => {
    async function order(userId: number, status: 'pending_payment' | 'paid' | 'shipped') {
      sequence += 1;
      const [row] = await ctx.db
        .insert(orders)
        .values({
          orderNo: `G1${String(sequence).padStart(10, '0')}`,
          userId,
          platform: 'wechat_mini',
          status,
          ...(status === 'pending_payment'
            ? {}
            : { paidAt: new Date(NOW), paidAmount: '10.00', transactionNo: `T${sequence}` }),
          ...(status === 'shipped'
            ? {
                fulfillmentStatus: 'fulfilled' as const,
                shippedAt: new Date(NOW),
                refundStatus: 'requested' as const,
              }
            : {}),
          totalQuantity: 1,
          itemsAmount: '10.00',
          payableAmount: '10.00',
          receiverName: '张三',
          receiverPhone: '13800000000',
          receiverProvince: '广东省',
          receiverCity: '深圳市',
          receiverDetail: '某路 1 号',
        })
        .returning({ id: orders.id });
      // 售后 counts orders with a request still open, read from `refunds`
      // itself, not from the order's roll-up flag.
      if (status === 'shipped') {
        await ctx.db.insert(refunds).values({
          refundNo: `G1RF${sequence}`,
          outRefundNo: `G1ORF${sequence}`,
          orderId: row!.id,
          userId,
          kind: 'refund_only',
          quantity: 1,
          amount: '10.00',
        });
      }
    }

    const userCenter = (showStats = true) => [
      { id: 'card', type: 'userCard', v: 1, props: { showStats } },
      { id: 'orders', type: 'orderEntry', v: 1, props: {} },
    ];

    it('DECOR-015: a shopper gets their own order counts, profile and totals; a guest gets none', async () => {
      const uid = await user('g1-shopper');
      await ctx.db.update(users).set({ nickname: '小林' }).where(eq(users.id, uid));
      await order(uid, 'pending_payment');
      await order(uid, 'pending_payment');
      await order(uid, 'paid');
      await order(uid, 'shipped');
      const a = await product();
      await ctx.db.insert(productFavorites).values({ userId: uid, productId: Number(a) });
      const other = await user('g1-other');
      await order(other, 'paid');

      const page = await previewOf(userCenter(), harness.as(shopper(uid)));
      expect(page.blocks.map((block) => block.data)).toEqual([{}, {}]);
      expect(page.personal).toEqual({
        card: {
          user: {
            kind: 'userSummary',
            user: {
              nickname: '小林',
              avatarUrl: null,
              profileIncomplete: true,
              stats: { coupons: 0, favorites: 1, history: 0 },
            },
          },
        },
        orders: {
          counts: {
            kind: 'orderCounts',
            counts: { unpaid: 2, unshipped: 1, unreceived: 1, aftersale: 1, unreviewed: 0 },
          },
        },
      });

      const theirs = await previewOf(userCenter(), harness.as(shopper(other)));
      expect(theirs.personal?.orders?.counts).toMatchObject({
        counts: { unpaid: 0, unshipped: 1, unreceived: 0, aftersale: 0 },
      });
      expect((await previewOf(userCenter(), anonymous())).personal).toBeNull();
    });

    it('DECOR-015: the totals are read only when the card shows them', async () => {
      const uid = await user('g1-nostats');
      const page = await previewOf(userCenter(false), harness.as(shopper(uid)));
      expect(page.personal?.card?.user).toEqual({
        kind: 'userSummary',
        user: { nickname: null, avatarUrl: null, profileIncomplete: true, stats: null },
      });
    });

    it('DECOR-015: the card stops asking for a profile once the nickname and avatar are chosen', async () => {
      const uid = await user('g1-chosen');
      const card = async () =>
        (await previewOf(userCenter(false), harness.as(shopper(uid)))).personal?.card?.user;
      await ctx.db.update(users).set({ nickname: '用户8000' }).where(eq(users.id, uid));
      expect(await card()).toMatchObject({ user: { profileIncomplete: true } });
      await ctx.db
        .update(users)
        .set({ nickname: '小林', avatarUrl: 'https://cdn.example.com/a.png' })
        .where(eq(users.id, uid));
      expect(await card()).toMatchObject({ user: { profileIncomplete: false } });
    });

    it('DECOR-015: a live 个人中心 is cached without anyone’s state, and each shopper still gets theirs', async () => {
      const first = await user('g1-first');
      const second = await user('g1-second');
      await order(first, 'pending_payment');
      const id = await live(
        'user_center',
        [...userCenter(), carousel('c', [slide])],
        'user_center',
      );
      expect(id).toBeTruthy();

      const one = await decor.resolveUserCenter(harness.as(shopper(first)), NO_CLIENT);
      const two = await decor.resolveUserCenter(harness.as(shopper(second)), NO_CLIENT);
      expect(one.version).toBe(two.version);
      expect(one.personal?.orders?.counts).toMatchObject({ counts: { unpaid: 1 } });
      expect(two.personal?.orders?.counts).toMatchObject({ counts: { unpaid: 0 } });

      const raw = await harness.redis.get(decor.revisionCacheKey(Number(one.version.slice(4))));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).not.toHaveProperty('personal');
      expect(raw).not.toMatch(/"unpaid":\d/);
      expect(raw).not.toContain('orderCounts","counts"');
      // What the cache keeps is which state to fetch, never the state.
      expect(JSON.parse(raw!).blocks[1].personalNeeds).toEqual({ counts: { kind: 'orderCounts' } });
    });

    it('DECOR-015: a personal lookup that fails costs its slot, not the page', async () => {
      const uid = await user('g1-gone');
      const signedIn = harness.as(shopper(uid));
      await ctx.db
        .update(users)
        .set({ deletedAt: new Date(NOW) })
        .where(eq(users.id, uid));
      const page = await previewOf(userCenter(), signedIn);
      expect(page.blocks.map((block) => block.id)).toEqual(['card', 'orders']);
      expect(page.personal?.card).toBeUndefined();
      expect(page.personal?.orders?.counts).toMatchObject({ kind: 'orderCounts' });
    });
  });
});

describe('the batch-2 blocks (G2)', () => {
  async function groupbuyCampaign(sortOrder = 0, status: 'active' | 'paused' = 'active') {
    const productId = Number(await product());
    const [row] = await ctx.db
      .insert(groupbuyActivities)
      .values({
        productId,
        title: `拼团${sequence}`,
        status,
        price: '39.00',
        originalPrice: '60.00',
        seatsRequired: 2,
        groupTtlSeconds: 86_400,
        stock: 10,
        perOrderQuantity: 1,
        sortOrder,
        startAt: new Date('2026-05-01T00:00:00.000Z'),
        endAt: new Date('2026-07-01T00:00:00.000Z'),
      })
      .returning({ id: groupbuyActivities.id });
    return String(row!.id);
  }

  async function presaleCampaign(sortOrder = 0, status: 'active' | 'draft' = 'active') {
    const productId = Number(await product());
    const [row] = await ctx.db
      .insert(presaleActivities)
      .values({
        productId,
        title: `预售${sequence}`,
        status,
        paymentMode: 'full',
        price: '49.00',
        originalPrice: '60.00',
        stock: 10,
        perOrderQuantity: 1,
        sortOrder,
        shipAfterDays: 7,
        startAt: new Date('2026-05-01T00:00:00.000Z'),
        endAt: new Date('2026-07-01T00:00:00.000Z'),
      })
      .returning({ id: presaleActivities.id });
    return String(row!.id);
  }

  const block = (id: string, type: string, props: Record<string, unknown> = {}) => ({
    id,
    type,
    v: 1,
    props,
  });

  const grantNewcomer = (uid: number) => withTx(ctx.db, (tx) => coupon.grantNewUser(tx, ctx, uid));

  it('DECOR-013: 优惠券 shows only what can be claimed now, in the operator’s order', async () => {
    const a = await template({ name: '甲' });
    const paused = await template({ name: '停', status: 'disabled' });
    const welcome = await template({ name: '新人', claimMode: 'new_user' });
    const b = await template({ name: '乙' });
    const page = await previewOf([
      block('c', 'couponList', { source: { mode: 'manual', ids: [b, paused, welcome, a] } }),
      block('all', 'couponList', { source: { mode: 'auto', limit: 10 } }),
    ]);
    expect(idsIn(page, 0, 'coupons')).toEqual([b, a]);
    expect(idsIn(page, 1, 'coupons').sort()).toEqual([a, b].sort());
    expect(page.personal).toBeNull();
  });

  it('DECOR-015: 优惠券 claim state is each shopper’s own, and never in the cached page', async () => {
    const limited = await template({ perUserLimit: 1 });
    const twice = await template({ perUserLimit: 2 });
    await live(
      'home',
      [block('c', 'couponList', { source: { mode: 'manual', ids: [limited, twice] } })],
      'home',
    );
    const [first, second] = [await user('g2-first'), await user('g2-second')];
    await coupon.claim(harness.as(shopper(first)), { id: limited });
    await coupon.claim(harness.as(shopper(first)), { id: twice });

    const one = await decor.resolveHome(harness.as(shopper(first)), NO_CLIENT);
    const two = await decor.resolveHome(harness.as(shopper(second)), NO_CLIENT);
    expect(one.version).toBe(two.version);
    expect(one.personal?.c?.coupons).toEqual({
      kind: 'coupons',
      items: [
        { templateId: limited, claimedCount: 1, canClaim: false },
        { templateId: twice, claimedCount: 1, canClaim: true },
      ],
    });
    expect(two.personal?.c?.coupons).toEqual({
      kind: 'coupons',
      items: [
        { templateId: limited, claimedCount: 0, canClaim: true },
        { templateId: twice, claimedCount: 0, canClaim: true },
      ],
    });
    // A claim after the page was cached shows at once: the state is never cached.
    await coupon.claim(harness.as(shopper(second)), { id: limited });
    const again = await decor.resolveHome(harness.as(shopper(second)), NO_CLIENT);
    expect(again.version).toBe(two.version);
    expect(again.personal?.c?.coupons).toMatchObject({
      items: [{ templateId: limited, claimedCount: 1, canClaim: false }, { claimedCount: 0 }],
    });

    const raw = await harness.redis.get(decor.revisionCacheKey(Number(one.version.slice(4))));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('claimedCount');
    expect(raw).not.toContain('canClaim');
    expect((await decor.resolveHome(anonymous(), NO_CLIENT)).personal).toBeNull();
  });

  it('DECOR-015: 新人券 shows a guest the templates, and a shopper only the 新人券 they still hold', async () => {
    const welcome = await template({ name: '新人礼', claimMode: 'new_user', minSpend: '0.00' });
    await template({ name: '手领', claimMode: 'manual' });
    const blocks = [block('n', 'newcomerCoupon', { limit: 2 })];

    const guest = await previewOf(blocks);
    expect(idsIn(guest, 0, 'coupons')).toEqual([welcome]);
    expect(guest.personal).toBeNull();

    const granted = await user('g2-new');
    expect(await grantNewcomer(granted)).toBe(1);
    const mine = await previewOf(blocks, harness.as(shopper(granted)));
    expect(mine.personal?.n?.held).toEqual({
      kind: 'newcomerCoupons',
      coupons: [
        expect.objectContaining({ templateId: welcome, title: '新人礼', discountAmount: '10.00' }),
      ],
    });

    // Registered before the template existed: nothing held, the block hides itself.
    const veteran = await user('g2-veteran');
    const theirs = await previewOf(blocks, harness.as(shopper(veteran)));
    expect(theirs.personal?.n?.held).toEqual({ kind: 'newcomerCoupons', coupons: [] });

    // Spent: gone from the block on the next resolve.
    const [held] = await coupon.listHeldNewUser(harness.as(shopper(granted)), 5);
    await withTx(ctx.db, (tx) =>
      coupon.redeem(tx, ctx, { userCouponId: Number(held!.id), userId: granted, orderId: 1 }),
    );
    const after = await previewOf(blocks, harness.as(shopper(granted)));
    expect(after.personal?.n?.held).toEqual({ kind: 'newcomerCoupons', coupons: [] });
  });

  it('DECOR-015: a live 新人券 block is cached without anyone’s wallet', async () => {
    await template({ name: '新人礼', claimMode: 'new_user' });
    await live('home', [block('n', 'newcomerCoupon')], 'home');
    const uid = await user('g2-cached');
    await grantNewcomer(uid);
    const page = await decor.resolveHome(harness.as(shopper(uid)), NO_CLIENT);
    expect(page.personal?.n?.held).toMatchObject({ coupons: [{ title: '新人礼' }] });
    const raw = await harness.redis.get(decor.revisionCacheKey(Number(page.version.slice(4))));
    expect(JSON.parse(raw!).blocks[0].personalNeeds).toEqual({
      held: { kind: 'newcomerCoupons', limit: 3 },
    });
    expect(raw).not.toContain('newcomerCoupons","coupons"');
    expect(raw).not.toContain('gift_new_user');
  });

  it('DECOR-013: a manual 拼团 / 预售 pick is found by id, however far down the list it sits', async () => {
    const hidden = await groupbuyCampaign(-1);
    const paused = await groupbuyCampaign(0, 'paused');
    const top = await groupbuyCampaign(5);
    const buried = await presaleCampaign(-1);
    const draft = await presaleCampaign(0, 'draft');
    const first = await presaleCampaign(5);

    const page = await previewOf([
      block('g', 'groupbuyList', { source: { mode: 'manual', ids: [hidden, paused, top] } }),
      block('ga', 'groupbuyList', { source: { mode: 'auto', limit: 1 } }),
      block('p', 'presaleList', { source: { mode: 'manual', ids: [draft, buried, first] } }),
      block('pa', 'presaleList', { source: { mode: 'auto', limit: 1 } }),
    ]);
    const campaigns = (index: number) =>
      (page.blocks[index]!.data.campaigns as { activityId: string }[]).map((c) => c.activityId);
    expect(campaigns(0)).toEqual([hidden, top]);
    expect(campaigns(1)).toEqual([top]);
    expect(campaigns(2)).toEqual([buried, first]);
    expect(campaigns(3)).toEqual([first]);
    expect(page.blocks[2]!.data.campaigns).toEqual([
      expect.objectContaining({ price: '49.00', originalPrice: '60.00', shipAfterDays: 7 }),
      expect.anything(),
    ]);
  });

  it('DECOR-004: a picked campaign that is not running is a warning, checked by id', async () => {
    const running = await groupbuyCampaign(-1);
    const paused = await groupbuyCampaign(0, 'paused');
    const draft = await presaleCampaign(0, 'draft');
    const { id } = await drafted('custom', [
      block('g', 'groupbuyList', { source: { mode: 'manual', ids: [running, paused] } }),
      block('p', 'presaleList', { source: { mode: 'manual', ids: [draft] } }),
    ]);
    const reread = await decor.getDocument(ctx, { id });
    expect(reread.issues).toEqual([]);
    expect(reread.warnings.map((warning) => warning.message)).toEqual([
      `拼团活动 ${paused} 未在进行中或不存在，商城中不会显示`,
      `预售活动 ${draft} 未在进行中或不存在，商城中不会显示`,
    ]);
  });

  it('DECOR-013: 资讯 resolves a category’s newest published articles', async () => {
    const older = await article({ publishedAt: new Date('2026-04-01T00:00:00.000Z') });
    const newer = await article({ publishedAt: new Date('2026-05-10T00:00:00.000Z') });
    await article({ status: 'draft' });
    const page = await previewOf([
      block('a', 'articleList', { source: { mode: 'category', limit: 5 } }),
      block('m', 'articleList', { source: { mode: 'manual', ids: [older] } }),
    ]);
    expect(idsIn(page, 0, 'articles')).toEqual([newer, older]);
    expect(idsIn(page, 1, 'articles')).toEqual([older]);
  });

  it('DECOR-018: a page takes one 悬浮客服 and one 关注公众号, and publishing more is refused', async () => {
    const one = await drafted('home', [
      block('f', 'floatingContact'),
      block('o', 'followOfficialAccount'),
      block('v', 'video', { src: 'https://cdn.example.com/a.mp4' }),
    ]);
    expect((await decor.getDocument(ctx, { id: one.id })).issues).toEqual([]);
    await decor.publish(ctx, { id: one.id, note: '' });

    const two = await drafted('home', [
      block('f1', 'floatingContact'),
      block('f2', 'floatingContact', { side: 'left' }),
      block('o1', 'followOfficialAccount'),
      block('o2', 'followOfficialAccount'),
    ]);
    const reread = await decor.getDocument(ctx, { id: two.id });
    expect(reread.issues).toEqual([
      { path: 'blocks.1.type', message: '「悬浮客服」一个页面最多 1 个' },
      { path: 'blocks.3.type', message: '「关注公众号」一个页面最多 1 个' },
    ]);
    expect(await codeOf(decor.publish(ctx, { id: two.id, note: '' }))).toBe(
      'DECOR_DOCUMENT_INVALID',
    );
  });
});
