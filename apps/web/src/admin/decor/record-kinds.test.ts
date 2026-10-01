import { afterEach, describe, expect, it } from 'vitest';

import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import { catalogAdminLabelList } from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import {
  cmsArticleDetail,
  cmsArticleList,
  cmsCategoryList,
} from '@shop/contracts/cms/cms.admin.contract';
import {
  adminArticleDetailExample,
  adminArticleExample,
  articleCategoryChildExample,
  articleCategoryExample,
  type AdminArticleListItem,
} from '@shop/contracts/cms/schemas';
import { couponAdminDetail, couponAdminList } from '@shop/contracts/coupon/coupon.admin.contract';
import { decorDocumentList } from '@shop/contracts/decor/decor.admin.contract';
import {
  couponTemplateDetailExample,
  couponTemplateExample,
  type CouponTemplateListItem,
} from '@shop/contracts/coupon/schemas';
import {
  groupbuyAdminActivityDetail,
  groupbuyAdminActivityList,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import { presaleAdminActivityList } from '@shop/contracts/presale/presale.admin.contract';
import {
  groupbuyActivityDetailExample,
  groupbuyActivityExample,
  type GroupbuyActivityListItem,
} from '@shop/contracts/groupbuy/schemas';

import { on, respondWithError, stubRoutes } from '@/test/api';

import { resetApiConfig } from '../api';
import { isClaimableNow, isRunningNow } from './record-kinds';
import { createDecorRecordSource, type DecorRecordKind } from './records';

/**
 * The editor's data source, kind by kind.
 *
 * Whatever a picker offers is saved into the page and rendered by the
 * storefront, so each kind is asserted on the route it calls, the filter it
 * sends, and the row it maps back. Through a stubbed `fetch`, so the query
 * string the admin client builds is part of the assertion.
 */

afterEach(() => resetApiConfig());

const NOW = new Date('2026-06-15T12:00:00+08:00');
const source = () => createDecorRecordSource({ now: () => NOW });

const article: AdminArticleListItem = {
  ...adminArticleExample,
  id: '101',
  title: '双十一活动说明',
  coverImageUrl: '/uploads/cover.png',
  categoryTitle: '新闻资讯',
};

const coupon = (overrides: Partial<CouponTemplateListItem>): CouponTemplateListItem => ({
  ...couponTemplateExample,
  claimFrom: '2026-01-01T00:00:00+08:00',
  claimTo: '2026-12-31T23:59:59+08:00',
  validTo: '2026-12-31T23:59:59+08:00',
  ...overrides,
});

const activity = (overrides: Partial<GroupbuyActivityListItem>): GroupbuyActivityListItem => ({
  ...groupbuyActivityExample,
  startAt: '2026-06-01T00:00:00+08:00',
  endAt: '2026-06-30T23:59:59+08:00',
  ...overrides,
});

describe('文章', () => {
  it('pages published articles and maps title, cover and category', async () => {
    const calls = stubRoutes([
      on(cmsArticleList, { items: [article], total: 31, page: 2, pageSize: 10 }),
    ]);

    const result = await source().list('article', {
      keyword: '双十一',
      categoryId: '3',
      page: 2,
      pageSize: 10,
    });

    expect(calls[0]?.path).toBe('/admin-api/cms/articles');
    // A draft is a 404 on the storefront, so it is never offered.
    expect(calls[0]?.query.get('status')).toBe('published');
    expect(calls[0]?.query.get('keyword')).toBe('双十一');
    expect(calls[0]?.query.get('categoryId')).toBe('3');
    expect(calls[0]?.query.get('page')).toBe('2');
    expect(result).toEqual({
      items: [
        { id: '101', name: '双十一活动说明', image: '/uploads/cover.png', subtitle: '新闻资讯' },
      ],
      total: 31,
    });
  });

  it('falls back to the publish date when an article has no category', async () => {
    stubRoutes([
      on(cmsArticleList, {
        items: [
          {
            ...article,
            coverImageUrl: null,
            categoryId: null,
            categoryTitle: null,
            publishedAt: '2026-10-20T10:00:00+08:00',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
      }),
    ]);
    const result = await source().list('article', { page: 1, pageSize: 10 });
    expect(result.items).toEqual([{ id: '101', name: '双十一活动说明', subtitle: '2026-10-20' }]);
  });

  it('resolves stored ids through the detail route, dropping a deleted one', async () => {
    const calls = stubRoutes([
      on(cmsArticleDetail, (call) =>
        call.params.id === '9'
          ? respondWithError(404, { code: 'CMS_ARTICLE_NOT_FOUND', message: '文章不存在' })
          : { ...adminArticleDetailExample, ...article },
      ),
    ]);

    const rows = await source().resolve('article', ['101', '9']);

    expect(calls.map((call) => call.params.id)).toEqual(['101', '9']);
    expect(rows).toEqual([
      { id: '101', name: '双十一活动说明', image: '/uploads/cover.png', subtitle: '新闻资讯' },
    ]);
  });

  it('throws on anything but a 404, so an outage never reads as "nothing picked"', async () => {
    stubRoutes([
      on(cmsArticleDetail, () =>
        respondWithError(500, { code: 'INTERNAL', message: '服务器开小差了' }),
      ),
    ]);
    await expect(source().resolve('article', ['101'])).rejects.toMatchObject({ status: 500 });
  });

  it('nests the visible 文章分类 under their parents', async () => {
    const calls = stubRoutes([
      on(cmsCategoryList, { items: [articleCategoryExample, articleCategoryChildExample] }),
    ]);

    const tree = await source().categories('article');

    expect(calls[0]?.query.get('status')).toBe('visible');
    expect(tree).toEqual([
      { id: '3', name: '新闻资讯', children: [{ id: '4', name: '商城公告' }] },
    ]);
  });
});

describe('优惠券', () => {
  it('offers exactly what the 领券中心 lists right now', () => {
    expect(isClaimableNow(coupon({}), NOW)).toBe(true);
    expect(isClaimableNow(coupon({ status: 'disabled' }), NOW)).toBe(false);
    expect(isClaimableNow(coupon({ claimMode: 'new_user' }), NOW)).toBe(false);
    expect(isClaimableNow(coupon({ claimFrom: '2026-07-01T00:00:00+08:00' }), NOW)).toBe(false);
    expect(isClaimableNow(coupon({ claimTo: '2026-06-01T00:00:00+08:00' }), NOW)).toBe(false);
    expect(isClaimableNow(coupon({ remainingCount: 0 }), NOW)).toBe(false);
    expect(
      isClaimableNow(coupon({ remainingCount: 0, isUnlimitedSupply: true, totalCount: null }), NOW),
    ).toBe(true);
    expect(isClaimableNow(coupon({ validTo: '2026-06-01T00:00:00+08:00' }), NOW)).toBe(false);
    // Open-ended windows are open.
    expect(isClaimableNow(coupon({ claimFrom: null, claimTo: null, validTo: null }), NOW)).toBe(
      true,
    );
  });

  it('asks for active, hand-claimed templates and drops the ones not claimable now', async () => {
    const calls = stubRoutes([
      on(couponAdminList, {
        items: [
          coupon({ id: '1', name: '满 100 减 10' }),
          coupon({ id: '2', name: '已领完', remainingCount: 0 }),
          coupon({ id: '3', name: '无门槛', minSpend: '0.00', discountAmount: '5.00' }),
        ],
        total: 3,
        page: 1,
        pageSize: 100,
      }),
    ]);

    const result = await source().list('coupon', { keyword: '满', page: 1, pageSize: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/admin-api/coupons');
    expect(calls[0]?.query.get('status')).toBe('active');
    expect(calls[0]?.query.get('claimMode')).toBe('manual');
    expect(calls[0]?.query.get('keyword')).toBe('满');
    // The id is the template id: what the storefront's coupon list answers as `id`.
    expect(result).toEqual({
      items: [
        { id: '1', name: '满 100 减 10', subtitle: '满 ¥100.00 减 ¥10.00' },
        { id: '3', name: '无门槛', subtitle: '无门槛 减 ¥5.00' },
      ],
      total: 2,
    });
  });

  it('reads the whole list before paging, so the total and the pages agree', async () => {
    const all = Array.from({ length: 130 }, (_unused, i) =>
      coupon({ id: String(i + 1), name: `券 ${i + 1}`, remainingCount: i % 2 === 0 ? 5 : 0 }),
    );
    const calls = stubRoutes([
      on(couponAdminList, (call) => {
        const page = Number(call.query.get('page'));
        const pageSize = Number(call.query.get('pageSize'));
        return {
          items: all.slice((page - 1) * pageSize, page * pageSize),
          total: all.length,
          page,
          pageSize,
        };
      }),
    ]);

    const result = await source().list('coupon', { page: 2, pageSize: 10 });

    expect(calls.map((call) => call.query.get('page'))).toEqual(['1', '2']);
    // 65 of the 130 are in stock; page 2 is the 11th to 20th of those.
    expect(result.total).toBe(65);
    expect(result.items.map((row) => row.id)).toEqual([
      '21',
      '23',
      '25',
      '27',
      '29',
      '31',
      '33',
      '35',
      '37',
      '39',
    ]);
  });

  it('resolves stored template ids through the detail route', async () => {
    stubRoutes([
      on(couponAdminDetail, (call) =>
        call.params.id === '9'
          ? respondWithError(404, { code: 'COUPON_TEMPLATE_NOT_FOUND', message: '优惠券不存在' })
          : { ...couponTemplateDetailExample, id: call.params.id ?? '' },
      ),
    ]);
    expect(await source().resolve('coupon', ['1', '9'])).toEqual([
      { id: '1', name: '满 100 减 10', subtitle: '满 ¥100.00 减 ¥10.00' },
    ]);
  });
});

describe('拼团', () => {
  it('offers the activities the storefront is running now', () => {
    expect(isRunningNow(activity({}), NOW)).toBe(true);
    expect(isRunningNow(activity({ status: 'paused' }), NOW)).toBe(false);
    expect(isRunningNow(activity({ startAt: '2026-07-01T00:00:00+08:00' }), NOW)).toBe(false);
    expect(isRunningNow(activity({ endAt: '2026-06-15T12:00:00+08:00' }), NOW)).toBe(false);
  });

  it('asks for active activities and maps title, image, price and seats', async () => {
    const calls = stubRoutes([
      on(groupbuyAdminActivityList, {
        items: [
          activity({ id: '1' }),
          activity({ id: '2', title: '未开始', startAt: '2026-07-01T00:00:00+08:00' }),
        ],
        total: 2,
        page: 1,
        pageSize: 100,
      }),
    ]);

    const result = await source().list('groupbuy', { page: 1, pageSize: 10 });

    expect(calls[0]?.path).toBe('/admin-api/groupbuy-activities');
    expect(calls[0]?.query.get('status')).toBe('active');
    // The id is the activity id, which the storefront's 拼团 pages open by.
    expect(result).toEqual({
      items: [
        {
          id: '1',
          name: '三人成团 · 坚果礼盒',
          image: 'https://cdn.example.com/p/11.jpg',
          subtitle: '¥59.00 · 3 人团',
        },
      ],
      total: 1,
    });
  });

  it('resolves stored activity ids through the detail route', async () => {
    stubRoutes([on(groupbuyAdminActivityDetail, groupbuyActivityDetailExample)]);
    expect(await source().resolve('groupbuy', ['1'])).toEqual([
      {
        id: '1',
        name: '三人成团 · 坚果礼盒',
        image: 'https://cdn.example.com/p/11.jpg',
        subtitle: '¥59.00 · 3 人团',
      },
    ]);
  });
});

describe('createDecorRecordSource', () => {
  it.each([
    ['product', catalogAdminProductList.id],
    ['label', catalogAdminLabelList.id],
    ['article', cmsArticleList.id],
    ['coupon', couponAdminList.id],
    ['groupbuy', groupbuyAdminActivityList.id],
    ['presale', presaleAdminActivityList.id],
    ['page', decorDocumentList.id],
  ] satisfies [DecorRecordKind, string][])(
    'answers %s from its owning route, never from an in-memory list',
    async (kind, routeId) => {
      const empty = { items: [], total: 0, page: 1, pageSize: 10 };
      const calls = stubRoutes([
        on(catalogAdminProductList, empty),
        on(catalogAdminLabelList, empty),
        on(cmsArticleList, empty),
        on(couponAdminList, empty),
        on(groupbuyAdminActivityList, empty),
        on(presaleAdminActivityList, empty),
        on(decorDocumentList, empty),
      ]);
      expect(await source().list(kind, { page: 1, pageSize: 10 })).toEqual({
        items: [],
        total: 0,
      });
      expect(calls.map((call) => call.routeId)).toEqual([routeId]);
    },
  );

  it('answers both category trees from their owning routes', async () => {
    const calls = stubRoutes([
      on(catalogAdminCategoryTree, { items: [] }),
      on(cmsCategoryList, { items: [] }),
    ]);
    await source().categories('product');
    await source().categories('article');
    expect(calls.map((call) => call.routeId)).toEqual([
      catalogAdminCategoryTree.id,
      cmsCategoryList.id,
    ]);
  });
});
