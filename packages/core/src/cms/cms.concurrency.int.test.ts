import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';

import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import * as articles from './cms.article.service';
import * as categories from './cms.category.service';

/**
 * One race per conditional state change in `cms`.
 *
 * Two of them: the article slug, which is a unique index the service turns
 * into a refusal, and the category delete's "still empty?" check. The view
 * counter is the third, and it is asserted where it is written — "loses no view
 * under concurrency" in `cms.int.test.ts`, next to the rest of the storefront
 * read.
 */

let harness: TestCtx;
let other: Ctx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  // A second editor, on its own context: two people saving at once.
  other = forkTestCtx(harness);
});

/** Alternates between the two independent contexts. */
const ctxFor = (index: number): Ctx => (index % 2 === 0 ? harness.ctx : other);

const codeOf = (error: unknown): string | undefined =>
  error instanceof DomainError ? error.code : undefined;

describe('two editors publishing the same slug', () => {
  it('gives it to one of them and refuses the rest', async () => {
    const report = await runConcurrently(5, (index) =>
      articles.create(ctxFor(index), {
        title: `双十一活动说明 ${index}`,
        slug: 'double-eleven-2026',
        categoryId: null,
        author: null,
        coverImageUrl: null,
        summary: null,
        shareTitle: null,
        shareSummary: null,
        sourceUrl: null,
        productId: null,
        contentHtml: '<p>活动时间：11 月 1 日至 11 月 11 日。</p>',
        status: 'published',
        isHot: false,
        isBanner: false,
        sortOrder: 0,
      }),
    );

    expect(report.winners).toBe(1);
    expect(report.rejected.map(codeOf)).toEqual(
      Array.from({ length: 4 }, () => 'CMS_ARTICLE_SLUG_TAKEN'),
    );

    const listed = await articles.list(harness.ctx, { page: 1, pageSize: 20 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.slug).toBe('double-eleven-2026');
  });
});

describe('deleting one category from two screens at once', () => {
  it('deletes it once and tells the loser it is gone', async () => {
    const created = await categories.create(harness.ctx, {
      title: '新闻资讯',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });

    const report = await runConcurrently(4, (index) =>
      categories.remove(ctxFor(index), { id: created.id }),
    );

    expect(report.winners).toBe(1);
    expect(report.rejected.map(codeOf)).toEqual(
      Array.from({ length: 3 }, () => 'CMS_CATEGORY_NOT_FOUND'),
    );
    expect((await categories.list(harness.ctx, {})).items).toEqual([]);
  });
});
