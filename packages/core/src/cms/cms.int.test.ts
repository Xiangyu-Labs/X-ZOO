import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ArticleForm } from '@shop/contracts/cms/schemas';
import { products } from '@shop/db/schema/catalog';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { DomainError } from '../kernel/errors';
import * as articles from './cms.article.service';
import * as categories from './cms.category.service';

/**
 * The CMS domain against a real PostgreSQL 17.
 *
 * The sanitiser's table lives next door in `cms.sanitize.test.ts` and needs no
 * database. What is proven here is everything the database is the authority
 * for: the two-level tree, the slug's unique index, the published filter, and
 * the view counter under concurrency — which is the one thing a unit test
 * cannot show, because the defect it guards against is a read-modify-write
 * race.
 */

let harness: TestCtx;

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
});

let sequence = 0;

function articleForm(overrides: Partial<ArticleForm> = {}): ArticleForm {
  sequence += 1;
  return {
    title: `文章${sequence}`,
    categoryId: null,
    slug: null,
    author: null,
    coverImageUrl: null,
    summary: null,
    shareTitle: null,
    shareSummary: null,
    sourceUrl: null,
    productId: null,
    contentHtml: '',
    status: 'draft',
    isHot: false,
    isBanner: false,
    sortOrder: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

describe('文章分类', () => {
  it('lists parents followed by their own children, with the published count', async () => {
    const news = await categories.create(harness.ctx, {
      title: '新闻资讯',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 10,
    });
    const notice = await categories.create(harness.ctx, {
      title: '商城公告',
      parentId: news.id,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 20,
    });
    await articles.create(harness.ctx, articleForm({ categoryId: news.id, status: 'published' }));
    await articles.create(harness.ctx, articleForm({ categoryId: news.id, status: 'draft' }));

    const { items } = await categories.list(harness.ctx, {});
    expect(items.map((item) => [item.title, item.depth, item.articleCount])).toEqual([
      ['新闻资讯', 0, 1],
      ['商城公告', 1, 0],
    ]);
    expect(items[1]?.parentId).toBe(notice.parentId);
  });

  it('refuses a third level and a cycle', async () => {
    const top = await categories.create(harness.ctx, {
      title: '一级',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });
    const child = await categories.create(harness.ctx, {
      title: '二级',
      parentId: top.id,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });

    const form = {
      title: '三级',
      parentId: child.id,
      intro: null,
      imageUrl: null,
      status: 'visible' as const,
      sortOrder: 0,
    };
    await expect(categories.create(harness.ctx, form)).rejects.toMatchObject({
      code: 'CMS_CATEGORY_TOO_DEEP',
    });

    // Moving a parent under its own child is the cycle the tree cannot express.
    await expect(
      categories.update(
        harness.ctx,
        { id: top.id },
        { ...form, title: '一级', parentId: child.id },
      ),
    ).rejects.toMatchObject({ code: 'CMS_CATEGORY_CYCLE' });
  });

  it('will not delete a category that still holds children or articles', async () => {
    const top = await categories.create(harness.ctx, {
      title: '一级',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });
    await articles.create(harness.ctx, articleForm({ categoryId: top.id }));

    const error = await categories
      .remove(harness.ctx, { id: top.id })
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: 'CMS_CATEGORY_NOT_EMPTY',
      details: { children: 0, articles: 1 },
    });
  });

  it('hides a hidden parent and its children from the storefront', async () => {
    const top = await categories.create(harness.ctx, {
      title: '公开',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });
    await categories.create(harness.ctx, {
      title: '子分类',
      parentId: top.id,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });
    const hidden = await categories.create(harness.ctx, {
      title: '内部',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'hidden',
      sortOrder: 0,
    });

    const before = await categories.publicList(harness.ctx);
    expect(before.items.map((item) => item.title)).toEqual(['公开']);
    expect(before.items[0]?.children.map((child) => child.title)).toEqual(['子分类']);

    await categories.setStatus(harness.ctx, { id: top.id }, { status: 'hidden' });
    const after = await categories.publicList(harness.ctx);
    expect(after.items).toEqual([]);
    expect(hidden.status).toBe('hidden');
  });

  it('soft-deletes an empty category', async () => {
    const empty = await categories.create(harness.ctx, {
      title: '空分类',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });
    await expect(categories.remove(harness.ctx, { id: empty.id })).resolves.toEqual({
      deleted: true,
    });
    const { items } = await categories.list(harness.ctx, {});
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// articles
// ---------------------------------------------------------------------------

describe('文章', () => {
  it('sanitises the body on write, so the stored html is already safe', async () => {
    const created = await articles.create(
      harness.ctx,
      articleForm({
        contentHtml: '<p onclick="alert(1)">活动</p><script>alert(2)</script>',
        status: 'published',
      }),
    );
    expect(created.contentHtml).toBe('<p>活动</p>');

    const read = await articles.detail(harness.ctx, { id: created.id });
    expect(read.contentHtml).toBe('<p>活动</p>');
  });

  it('stamps publishedAt once and keeps it across hide and re-publish', async () => {
    const created = await articles.create(harness.ctx, articleForm({ status: 'published' }));
    expect(created.publishedAt).toBe('2026-06-01T00:00:00.000Z');

    await articles.setStatus(harness.ctx, { id: created.id }, { status: 'hidden' });
    const back = await articles.setStatus(harness.ctx, { id: created.id }, { status: 'published' });
    expect(back.publishedAt).toBe(created.publishedAt);
  });

  it('refuses a duplicate slug and frees it again on delete', async () => {
    await articles.create(harness.ctx, articleForm({ slug: 'double-eleven' }));
    await expect(
      articles.create(harness.ctx, articleForm({ slug: 'double-eleven' })),
    ).rejects.toMatchObject({ code: 'CMS_ARTICLE_SLUG_TAKEN', details: { slug: 'double-eleven' } });

    const { items } = await articles.list(harness.ctx, { page: 1, pageSize: 20 });
    await articles.remove(harness.ctx, { id: items[0]!.id });
    await expect(
      articles.create(harness.ctx, articleForm({ slug: 'double-eleven' })),
    ).resolves.toMatchObject({ slug: 'double-eleven' });
  });

  it('refuses an unknown category', async () => {
    await expect(
      articles.create(harness.ctx, articleForm({ categoryId: '999999' })),
    ).rejects.toMatchObject({ code: 'CMS_CATEGORY_NOT_FOUND' });
  });

  it('renders the related product through the catalog', async () => {
    const [product] = await harness.ctx.db
      .insert(products)
      .values({
        name: '云南小粒咖啡豆 500g',
        imageUrl: 'https://example.test/coffee.png',
        status: 'on_shelf',
        price: '69.00',
        originalPrice: '99.00',
        freightMode: 'free',
      })
      .returning({ id: products.id });

    const created = await articles.create(
      harness.ctx,
      articleForm({ productId: String(product!.id), status: 'published' }),
    );
    expect(created.product).toMatchObject({ name: '云南小粒咖啡豆 500g', price: '69.00' });

    // An off-shelf product is not advertised; the article still renders.
    await harness.ctx.db.update(products).set({ status: 'off_shelf' });
    const again = await articles.detail(harness.ctx, { id: created.id });
    expect(again.product).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

describe('文章 storefront', () => {
  it('serves published articles only, by id as well as in the list', async () => {
    const draft = await articles.create(harness.ctx, articleForm({ status: 'draft' }));
    const hidden = await articles.create(harness.ctx, articleForm({ status: 'hidden' }));
    const live = await articles.create(harness.ctx, articleForm({ status: 'published' }));

    const list = await articles.publicList(harness.ctx, { page: 1, pageSize: 20 });
    expect(list.items.map((item) => item.id)).toEqual([live.id]);
    expect(list.total).toBe(1);

    for (const invisible of [draft, hidden]) {
      await expect(articles.publicDetail(harness.ctx, { id: invisible.id })).rejects.toMatchObject({
        code: 'CMS_ARTICLE_NOT_FOUND',
      });
    }
  });

  it('filters by category and by feature', async () => {
    const category = await categories.create(harness.ctx, {
      title: '公告',
      parentId: null,
      intro: null,
      imageUrl: null,
      status: 'visible',
      sortOrder: 0,
    });
    const hot = await articles.create(
      harness.ctx,
      articleForm({ status: 'published', isHot: true, categoryId: category.id }),
    );
    const banner = await articles.create(
      harness.ctx,
      articleForm({ status: 'published', isBanner: true }),
    );

    const byCategory = await articles.publicList(harness.ctx, {
      page: 1,
      pageSize: 20,
      categoryId: category.id,
    });
    expect(byCategory.items.map((item) => item.id)).toEqual([hot.id]);
    expect(byCategory.items[0]?.categoryTitle).toBe('公告');

    const hots = await articles.publicList(harness.ctx, { page: 1, pageSize: 20, feature: 'hot' });
    expect(hots.items.map((item) => item.id)).toEqual([hot.id]);

    const banners = await articles.publicList(harness.ctx, {
      page: 1,
      pageSize: 20,
      feature: 'banner',
    });
    expect(banners.items.map((item) => item.id)).toEqual([banner.id]);
  });

  /**
   * Twenty simultaneous readers add twenty views. Reading the counter, adding
   * one in application code and writing it back would land this test somewhere
   * between 1 and 20.
   */
  it('loses no view under concurrency', async () => {
    const article = await articles.create(harness.ctx, articleForm({ status: 'published' }));
    const reads = await Promise.all(
      Array.from({ length: 20 }, () => articles.publicDetail(harness.ctx, { id: article.id })),
    );

    const seen = reads.map((read) => read.views).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 20 }, (_unused, index) => index + 1));

    const after = await articles.detail(harness.ctx, { id: article.id });
    expect(after.views).toBe(20);
  });
});
