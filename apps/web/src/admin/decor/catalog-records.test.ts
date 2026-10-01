import { afterEach, describe, expect, it } from 'vitest';

import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import { catalogAdminLabelList } from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import {
  adminProductListItemExample,
  type AdminProductListItem,
  productCategoryChildExample,
  productCategoryExample,
  type ProductCategoryNode,
  type ProductLabel,
} from '@shop/contracts/catalog/schemas';

import { on, respondWithError, stubRoutes } from '@/test/api';

import { resetApiConfig } from '../api';
import { listLabels, listProducts, productCategoryTree, resolveProducts } from './catalog-records';

/**
 * The catalog's picker kinds, over the catalog contracts.
 *
 * The pickers are the only place a DIY node can gain a product, a category or a
 * 商品标签 id, so what this layer sends and what it maps back is as load-bearing
 * as the panels themselves. Tested through a stubbed `fetch` rather than a
 * mocked `callRoute`, so the query string the admin API actually builds is
 * part of the assertion.
 */

afterEach(() => resetApiConfig());

const product: AdminProductListItem = {
  ...adminProductListItemExample,
  id: '7',
  name: '牛仔外套',
  imageUrl: '/uploads/7.png',
  price: '199.00',
};

const label: ProductLabel = {
  id: '3',
  name: '包邮',
  style: 'text',
  fontColor: '#FFFFFF',
  backgroundColor: '#E93323',
  borderColor: null,
  imageUrl: null,
  categoryId: '1',
  categoryName: '促销',
  isVisible: true,
  isEnabled: true,
  sortOrder: 0,
  productCount: 12,
  createdAt: '2026-01-01T10:00:00+08:00',
};

const tree: { items: ProductCategoryNode[] } = {
  items: [
    {
      ...productCategoryExample,
      id: '7',
      name: '服饰',
      children: [
        { ...productCategoryChildExample, id: '17', parentId: '7', name: 'T恤', children: [] },
      ],
    },
  ],
};

describe('the catalog picker kinds', () => {
  it('pages 商品 through the admin list, on-shelf only, and formats the price', async () => {
    const calls = stubRoutes([
      on(catalogAdminProductList, { items: [product], total: 42, page: 2, pageSize: 10 }),
    ]);
    const result = await listProducts({ keyword: '外套', page: 2, pageSize: 10 });

    expect(calls[0]?.url).toContain('/admin-api/catalog/products');
    // 已上架 only: a DIY page must not advertise a product nobody can open.
    expect(calls[0]?.url).toContain('tab=on_shelf');
    expect(calls[0]?.url).toContain('page=2');
    expect(calls[0]?.url).toContain(`keyword=${encodeURIComponent('外套')}`);
    expect(result).toEqual({
      items: [{ id: '7', name: '牛仔外套', image: '/uploads/7.png', subtitle: '¥199.00' }],
      total: 42,
    });
  });

  it('pages 商品标签 through the label list, enabled only', async () => {
    const calls = stubRoutes([
      on(catalogAdminLabelList, { items: [label], total: 1, page: 1, pageSize: 10 }),
    ]);
    const result = await listLabels({ page: 1, pageSize: 10 });

    expect(calls[0]?.url).toContain('/admin-api/catalog/labels');
    expect(calls[0]?.url).toContain('isEnabled=true');
    // A label with no image contributes no `image` key rather than an empty one.
    expect(result.items).toEqual([{ id: '3', name: '包邮', subtitle: '促销' }]);
  });

  it('resolves stored product ids in one list call, in their order, without the deleted', async () => {
    const calls = stubRoutes([
      on(catalogAdminProductList, {
        // The server leaves out 9, deleted since the page was saved.
        items: [{ ...product, id: '3', name: '白T恤', status: 'off_shelf' }, product],
        total: 2,
        page: 1,
        pageSize: 4,
      }),
    ]);
    const rows = await resolveProducts(['7', '9', '3', 'not-an-id']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.get('ids')).toBe('7,9,3');
    expect(calls[0]?.query.get('pageSize')).toBe('3');
    // No tab: an off-shelf pick is still the operator's pick.
    expect(calls[0]?.query.get('tab')).toBeNull();
    expect(rows).toEqual([
      { id: '7', name: '牛仔外套', image: '/uploads/7.png', subtitle: '¥199.00' },
      { id: '3', name: '白T恤', image: '/uploads/7.png', subtitle: '¥199.00 · 未上架' },
    ]);
  });

  it('throws when the list cannot be read, rather than answering "nothing picked"', async () => {
    stubRoutes([
      on(catalogAdminProductList, () =>
        respondWithError(500, { code: 'INTERNAL', message: '服务器开小差了' }),
      ),
    ]);
    await expect(resolveProducts(['7'])).rejects.toMatchObject({ status: 500 });
  });

  it('flattens the category tree into the picker tree, keeping the nesting', async () => {
    stubRoutes([on(catalogAdminCategoryTree, tree)]);
    const nodes = await productCategoryTree();
    expect(nodes).toEqual([{ id: '7', name: '服饰', children: [{ id: '17', name: 'T恤' }] }]);
  });
});
