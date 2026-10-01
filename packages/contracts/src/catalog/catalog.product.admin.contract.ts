import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  adminProductDetail,
  adminProductDetailExample,
  adminProductForm,
  adminProductFormExample,
  adminProductListItemExample,
  adminProductListQuery,
  adminProductStatusBody,
  pagedAdminProducts,
  pagedStockWarnings,
  pagedVirtualCards,
  productExportQuery,
  productExportResult,
  productVirtualCardExample,
  skuMatrixBody,
  skuMatrixResult,
  stockWarningItemExample,
  stockWarningListQuery,
  virtualCardImportBody,
  virtualCardImportResult,
  virtualCardListQuery,
  virtualCardVoidBody,
} from './schemas';

/**
 * Admin product routes, `/admin-api/catalog/products`.
 *
 * Note which things are **POSTed sub-resources** rather than fields of the
 * update body: shelf status, restore-from-recycle-bin, the card-key import and
 * voiding a card. Each is a different job with a different permission and a
 * different audit line; folded into one `save`, a product could be taken off
 * the shelf by somebody editing its description.
 */

const productParams = z.object({ id });

export const catalogAdminProductList = defineRoute({
  id: 'catalog.adminProductList',
  method: 'GET',
  path: '/admin-api/catalog/products',
  auth: 'admin',
  permission: 'catalog:product:read',
  summary: '商品列表',
  tags: ['catalog'],
  query: adminProductListQuery,
  response: pagedAdminProducts,
  examples: [
    {
      name: 'on-shelf',
      query: { page: 1, pageSize: 20, tab: 'on_shelf' },
      response: { items: [adminProductListItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'recycle-bin',
      query: { page: 1, pageSize: 20, tab: 'deleted' },
      response: {
        items: [{ ...adminProductListItemExample, deletedAt: '2026-04-01T09:00:00+08:00' }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
    {
      name: 'search',
      query: { page: 1, pageSize: 20, keyword: '白T', categoryId: '17' },
      response: { items: [adminProductListItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      // A saved DIY page's 指定商品, back into rows: 9 has been deleted since,
      // so it is absent; the rest come back in the order asked for.
      name: 'by-ids',
      query: { page: 1, pageSize: 3, ids: '4,9,1' },
      response: {
        items: [{ ...adminProductListItemExample, id: '4' }, adminProductListItemExample],
        total: 2,
        page: 1,
        pageSize: 3,
      },
    },
  ],
});

export const catalogAdminProductDetail = defineRoute({
  id: 'catalog.adminProductDetail',
  method: 'GET',
  path: '/admin-api/catalog/products/:id',
  auth: 'admin',
  permission: 'catalog:product:read',
  summary: '商品详情',
  tags: ['catalog'],
  params: productParams,
  response: adminProductDetail,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: adminProductDetailExample }],
});

export const catalogAdminProductCreate = defineRoute({
  id: 'catalog.adminProductCreate',
  method: 'POST',
  path: '/admin-api/catalog/products',
  auth: 'admin',
  permission: 'catalog:product:write',
  summary: '新建商品',
  tags: ['catalog'],
  body: adminProductForm,
  response: adminProductDetail,
  status: 201,
  errors: [
    'CATALOG_CATEGORY_NOT_FOUND',
    'CATALOG_LABEL_NOT_FOUND',
    'CATALOG_PROTECTION_NOT_FOUND',
    'CATALOG_PRODUCT_SPU_TAKEN',
  ],
  examples: [
    { name: 'two-sku', body: adminProductFormExample, response: adminProductDetailExample },
    {
      name: 'single-sku-virtual',
      body: {
        name: '月度会员兑换码',
        kind: 'virtual_card',
        status: 'draft',
        imageUrl: 'https://cdn.example.com/p/9.png',
        specMode: false,
        skus: [{ specValues: {}, price: '30.00', stock: 0 }],
        freightMode: 'free',
        categoryIds: ['7'],
      },
      response: {
        ...adminProductDetailExample,
        id: '9',
        name: '月度会员兑换码',
        subtitle: null,
        spu: null,
        kind: 'virtual_card',
        status: 'draft',
        imageUrl: 'https://cdn.example.com/p/9.png',
        price: '30.00',
        originalPrice: null,
        cost: null,
        stock: 0,
        sales: 0,
        displaySalesBoost: 0,
        views: 0,
        specMode: false,
        isHot: false,
        isRecommended: false,
        categoryIds: ['7'],
        categoryNames: ['男装'],
        labels: [],
        keyword: null,
        cardImageUrl: null,
        sliderImages: [],
        unitName: null,
        freightMode: 'free',
        fixedFreight: null,
        shippingTemplateId: null,
        purchaseLimitMode: 'none',
        purchaseLimitQuantity: null,
        descriptionHtml: '',
        specs: [],
        skus: [
          {
            id: '1100',
            skuCode: 'SKUZ8P1Q4R7',
            specText: '',
            specValues: {},
            imageUrl: null,
            price: '30.00',
            originalPrice: null,
            cost: null,
            stock: 0,
            sales: 0,
            barCode: null,
            weight: null,
            volume: null,
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
        params: [],
        protectionIds: [],
        labelIds: [],
        giftCouponIds: [],
      },
    },
  ],
});

export const catalogAdminProductUpdate = defineRoute({
  id: 'catalog.adminProductUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/products/:id',
  auth: 'admin',
  permission: 'catalog:product:write',
  summary: '编辑商品',
  tags: ['catalog'],
  params: productParams,
  body: adminProductForm,
  response: adminProductDetail,
  errors: [
    'CATALOG_PRODUCT_NOT_FOUND',
    'CATALOG_CATEGORY_NOT_FOUND',
    'CATALOG_LABEL_NOT_FOUND',
    'CATALOG_PROTECTION_NOT_FOUND',
    'CATALOG_PRODUCT_SPU_TAKEN',
    'CATALOG_SKU_STOCK_CHANGED',
    'CATALOG_SKU_IN_USE',
  ],
  examples: [
    {
      name: 'reprice',
      params: { id: '1' },
      body: {
        ...adminProductFormExample,
        skus: [
          { ...adminProductFormExample.skus[0]!, price: '49.00' },
          { ...adminProductFormExample.skus[1]!, price: '49.00' },
        ],
      },
      response: {
        ...adminProductDetailExample,
        price: '49.00',
        skus: [
          { ...adminProductDetailExample.skus[0]!, price: '49.00' },
          { ...adminProductDetailExample.skus[1]!, price: '49.00' },
        ],
      },
    },
  ],
});

/**
 * 上架 / 下架.
 *
 * Taking a product off the shelf must hide it from every storefront list *and*
 * refuse an order for it. Both halves hang off this one status column, which is
 * why it is a conditional update guarded on the value it moves from rather than
 * a blind write.
 */
export const catalogAdminProductSetStatus = defineRoute({
  id: 'catalog.adminProductSetStatus',
  method: 'POST',
  path: '/admin-api/catalog/products/:id/status',
  auth: 'admin',
  permission: 'catalog:product:write',
  summary: '上架/下架商品',
  tags: ['catalog'],
  params: productParams,
  body: adminProductStatusBody,
  response: adminProductDetail,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [
    {
      name: 'off-shelf',
      params: { id: '1' },
      body: { status: 'off_shelf' },
      response: { ...adminProductDetailExample, status: 'off_shelf' },
    },
  ],
});

/** Soft delete: the product moves to the recycle bin, nothing is removed. */
export const catalogAdminProductDelete = defineRoute({
  id: 'catalog.adminProductDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/products/:id',
  auth: 'admin',
  permission: 'catalog:product:delete',
  summary: '删除商品（移入回收站）',
  tags: ['catalog'],
  params: productParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

export const catalogAdminProductRestore = defineRoute({
  id: 'catalog.adminProductRestore',
  method: 'POST',
  path: '/admin-api/catalog/products/:id/restore',
  auth: 'admin',
  permission: 'catalog:product:delete',
  summary: '从回收站恢复商品',
  tags: ['catalog'],
  params: productParams,
  body: z.object({}).default({}),
  response: adminProductDetail,
  errors: ['CATALOG_PRODUCT_NOT_FOUND', 'CATALOG_PRODUCT_NOT_DELETED'],
  examples: [
    {
      name: 'ok',
      params: { id: '1' },
      body: {},
      // Restored products come back off the shelf: an operator decides when a
      // resurrected product is visible again, rather than the recycle bin doing it.
      response: { ...adminProductDetailExample, status: 'off_shelf', deletedAt: null },
    },
  ],
});

/**
 * The spec matrix, computed server-side.
 *
 * Pure: specs in, combinations out, nothing stored. The editor calls it when
 * the operator adds a spec value so that the grid it renders and the grid the
 * server will accept are produced by the same code.
 */
export const catalogAdminSkuMatrix = defineRoute({
  id: 'catalog.adminSkuMatrix',
  method: 'POST',
  path: '/admin-api/catalog/sku-matrix',
  auth: 'admin',
  permission: 'catalog:product:write',
  summary: '生成规格组合',
  tags: ['catalog'],
  body: skuMatrixBody,
  response: skuMatrixResult,
  examples: [
    {
      name: 'two-axes',
      body: {
        specs: [
          { name: '颜色', values: [{ value: '白' }] },
          { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
        ],
      },
      response: {
        rows: [
          { specValues: { 颜色: '白', 尺码: 'M' }, specText: '白|M' },
          { specValues: { 颜色: '白', 尺码: 'L' }, specText: '白|L' },
        ],
      },
    },
  ],
});

export const catalogAdminStockWarnings = defineRoute({
  id: 'catalog.adminStockWarnings',
  method: 'GET',
  path: '/admin-api/catalog/stock-warnings',
  auth: 'admin',
  permission: 'catalog:product:read',
  summary: '库存预警列表',
  tags: ['catalog'],
  query: stockWarningListQuery,
  response: pagedStockWarnings,
  examples: [
    {
      name: 'default-threshold',
      query: { page: 1, pageSize: 20 },
      response: { items: [stockWarningItemExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const catalogAdminProductExport = defineRoute({
  id: 'catalog.adminProductExport',
  method: 'GET',
  path: '/admin-api/catalog/product-export',
  auth: 'admin',
  permission: 'catalog:product:export',
  summary: '导出商品',
  tags: ['catalog'],
  query: productExportQuery,
  response: productExportResult,
  errors: ['CATALOG_EXPORT_TOO_LARGE'],
  examples: [
    {
      name: 'on-shelf',
      query: { tab: 'on_shelf', limit: 2000 },
      response: {
        filename: '商品列表-20260921.csv',
        columns: [
          { key: 'id', title: '商品ID' },
          { key: 'name', title: '商品名称' },
          { key: 'skuCode', title: '规格编码' },
          { key: 'specText', title: '规格' },
          { key: 'price', title: '售价' },
          { key: 'stock', title: '库存' },
          { key: 'sales', title: '销量' },
          { key: 'status', title: '状态' },
        ],
        rows: [
          {
            id: '1',
            name: '经典白T恤',
            skuCode: 'SKU7K3M9QX2',
            specText: '白|M',
            price: '59.00',
            stock: '120',
            sales: '33',
            status: '上架',
          },
        ],
        total: 1,
        truncated: false,
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// card-key inventory
// ---------------------------------------------------------------------------

export const catalogAdminVirtualCardList = defineRoute({
  id: 'catalog.adminVirtualCardList',
  method: 'GET',
  path: '/admin-api/catalog/products/:id/virtual-cards',
  auth: 'admin',
  permission: 'catalog:card:read',
  summary: '卡密库存列表',
  tags: ['catalog'],
  params: productParams,
  query: virtualCardListQuery,
  response: pagedVirtualCards,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [
    {
      name: 'unclaimed',
      params: { id: '9' },
      query: { page: 1, pageSize: 20, state: 'unclaimed' },
      response: { items: [productVirtualCardExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * Import a batch of card keys.
 *
 * The pool **is** the stock: importing bumps `product_skus.stock` in the same
 * transaction, and the form refuses a hand-typed stock for a card product. Kept
 * apart, the two drift and the shop sells cards that do not exist.
 */
export const catalogAdminVirtualCardImport = defineRoute({
  id: 'catalog.adminVirtualCardImport',
  method: 'POST',
  path: '/admin-api/catalog/products/:id/virtual-cards',
  auth: 'admin',
  permission: 'catalog:card:write',
  summary: '导入卡密',
  tags: ['catalog'],
  params: productParams,
  body: virtualCardImportBody,
  response: virtualCardImportResult,
  status: 201,
  errors: ['CATALOG_PRODUCT_NOT_FOUND', 'CATALOG_SKU_NOT_FOUND', 'CATALOG_NOT_A_CARD_PRODUCT'],
  examples: [
    {
      name: 'two-cards',
      params: { id: '9' },
      body: {
        skuId: '1100',
        cards: [
          { cardNo: '8800-1234-5678', cardSecret: '9f3a1c' },
          { cardNo: '8800-1234-5679', cardSecret: '2b7e44' },
        ],
      },
      response: { imported: 2, skippedCardNos: [], stock: 2 },
    },
    {
      name: 'one-duplicate',
      params: { id: '9' },
      body: { skuId: '1100', cards: [{ cardNo: '8800-1234-5678' }] },
      response: { imported: 0, skippedCardNos: ['8800-1234-5678'], stock: 2 },
    },
  ],
});

/** Withdraw unclaimed cards from the pool. A claimed card is never voided. */
export const catalogAdminVirtualCardVoid = defineRoute({
  id: 'catalog.adminVirtualCardVoid',
  method: 'POST',
  path: '/admin-api/catalog/products/:id/virtual-cards/voids',
  auth: 'admin',
  permission: 'catalog:card:write',
  summary: '作废卡密',
  tags: ['catalog'],
  params: productParams,
  body: virtualCardVoidBody,
  response: virtualCardImportResult.pick({ stock: true }).extend({
    voided: z.number().int().min(0),
  }),
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [
    {
      name: 'one-card',
      params: { id: '9' },
      body: { cardIds: ['7001'] },
      response: { voided: 1, stock: 1 },
    },
  ],
});
