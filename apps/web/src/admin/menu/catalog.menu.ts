import { defineMenu } from './types';

/**
 * 商品.
 *
 * One file per domain, aggregated by `pnpm gen` into the gitignored
 * `menu.gen.ts`, so adding a domain touches no shared index.
 *
 * `permission` here only decides what the sider shows; the server re-checks the
 * atom declared on each route. Both lists come from `catalogPermissions` in
 * `@shop/core/catalog/permissions.ts`, which is why 商品保障 has an entry of its
 * own rather than hiding behind 商品参数.
 *
 * 新建商品 is `hidden`: reachable, breadcrumb-able, never listed. The card
 * pool under a product resolves to 商品列表 and asks for `catalog:card:read`
 * on its own page.
 */
export default defineMenu({
  key: 'catalog',
  label: '商品',
  icon: 'ShopOutlined',
  order: 200,
  children: [
    {
      key: 'catalog.products',
      label: '商品列表',
      path: '/admin/catalog/products',
      permission: 'catalog:product:read',
      order: 10,
    },
    {
      key: 'catalog.products.new',
      label: '新建商品',
      path: '/admin/catalog/products/new',
      permission: 'catalog:product:write',
      order: 11,
      hidden: true,
    },
    {
      key: 'catalog.categories',
      label: '商品分类',
      path: '/admin/catalog/categories',
      permission: 'catalog:category:read',
      order: 20,
    },
    {
      key: 'catalog.reviews',
      label: '商品评价',
      path: '/admin/catalog/reviews',
      permission: 'catalog:review:read',
      order: 30,
    },
    {
      key: 'catalog.stockWarnings',
      label: '库存预警',
      path: '/admin/catalog/stock-warnings',
      permission: 'catalog:product:read',
      order: 40,
    },
    {
      key: 'catalog.labels',
      label: '商品标签',
      path: '/admin/catalog/labels',
      permission: 'catalog:label:read',
      order: 50,
    },
    {
      key: 'catalog.params',
      label: '商品参数',
      path: '/admin/catalog/params',
      permission: 'catalog:param:read',
      order: 60,
    },
    {
      key: 'catalog.protections',
      label: '商品保障',
      path: '/admin/catalog/protections',
      permission: 'catalog:protection:read',
      order: 70,
    },
  ],
});
