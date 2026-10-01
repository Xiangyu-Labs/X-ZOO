import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  adminProductReview,
  adminProductReviewExample,
  adminReviewForm,
  adminReviewListQuery,
  pagedAdminReviews,
  pagedReviews,
  productReview,
  productReviewStatus,
  submittedReview,
  productReviewExample,
  reviewBatchStatusBody,
  reviewBatchStatusResult,
  reviewListQuery,
  reviewReplyBody,
  reviewStatusBody,
  reviewSubmitBody,
  reviewSummary,
  reviewSummaryExample,
} from './schemas';

/**
 * Reviews, both surfaces, in one file because the two halves share a schema and
 * a moderation state that only makes sense read together.
 *
 * Moderation is a real state (`pending` / `published` / `hidden`), not a
 * `is_reply`+`is_del` pair. The default is `published` — the shop does not
 * pre-moderate today and pretending otherwise would hide every review behind a
 * queue nobody drains — and `catalog.reviewAudit` is what a shop that turns
 * moderation on uses. See `catalog.config.ts` (`reviewRequiresAudit`).
 */

const reviewParams = z.object({ id });
const productParams = z.object({ id });

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export const catalogAdminReviewList = defineRoute({
  id: 'catalog.adminReviewList',
  method: 'GET',
  path: '/admin-api/catalog/reviews',
  auth: 'admin',
  permission: 'catalog:review:read',
  summary: '商品评价列表',
  tags: ['catalog'],
  query: adminReviewListQuery,
  response: pagedAdminReviews,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [adminProductReviewExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'bad-unreplied',
      query: { page: 1, pageSize: 20, rating: 'bad', hasReply: 'false' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * 虚拟评论 — a review an operator writes for a product nobody has reviewed yet.
 *
 * It carries no `orderItemId`, which is what keeps
 * `product_reviews_order_item_uq` free for the real one a buyer may still
 * write. `authorNickname` is required: an unsigned seeded review reads as a
 * system message and fools nobody.
 */
export const catalogAdminReviewCreate = defineRoute({
  id: 'catalog.adminReviewCreate',
  method: 'POST',
  path: '/admin-api/catalog/reviews',
  auth: 'admin',
  permission: 'catalog:review:write',
  summary: '添加虚拟评价',
  tags: ['catalog'],
  body: adminReviewForm,
  response: adminProductReview,
  status: 201,
  errors: ['CATALOG_PRODUCT_NOT_FOUND', 'CATALOG_SKU_NOT_FOUND'],
  examples: [
    {
      name: 'five-star',
      body: {
        productId: '1',
        skuId: '1001',
        authorNickname: '小明',
        authorAvatarUrl: 'https://cdn.example.com/u/101.png',
        productScore: 5,
        serviceScore: 5,
        content: '料子很舒服，洗了不变形。',
        images: ['https://cdn.example.com/r/5001-1.png'],
      },
      response: {
        ...adminProductReviewExample,
        userId: null,
        orderId: null,
        orderItemId: null,
        replyContent: null,
        replyAt: null,
      },
    },
  ],
});

export const catalogAdminReviewReply = defineRoute({
  id: 'catalog.adminReviewReply',
  method: 'POST',
  path: '/admin-api/catalog/reviews/:id/reply',
  auth: 'admin',
  permission: 'catalog:review:write',
  summary: '回复商品评价',
  tags: ['catalog'],
  params: reviewParams,
  body: reviewReplyBody,
  response: adminProductReview,
  errors: ['CATALOG_REVIEW_NOT_FOUND', 'CATALOG_REVIEW_ALREADY_REPLIED'],
  examples: [
    {
      name: 'ok',
      params: { id: '5001' },
      body: { content: '感谢支持！' },
      response: adminProductReviewExample,
    },
  ],
});

/** Editing a reply already written. Separate from `reply` so the audit trail keeps both. */
export const catalogAdminReviewReplyUpdate = defineRoute({
  id: 'catalog.adminReviewReplyUpdate',
  method: 'PUT',
  path: '/admin-api/catalog/reviews/:id/reply',
  auth: 'admin',
  permission: 'catalog:review:write',
  summary: '修改评价回复',
  tags: ['catalog'],
  params: reviewParams,
  body: reviewReplyBody,
  response: adminProductReview,
  errors: ['CATALOG_REVIEW_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '5001' },
      body: { content: '感谢支持，已为您记录建议。' },
      response: { ...adminProductReviewExample, replyContent: '感谢支持，已为您记录建议。' },
    },
  ],
});

export const catalogAdminReviewSetStatus = defineRoute({
  id: 'catalog.adminReviewSetStatus',
  method: 'POST',
  path: '/admin-api/catalog/reviews/:id/status',
  auth: 'admin',
  permission: 'catalog:review:write',
  summary: '审核商品评价',
  tags: ['catalog'],
  params: reviewParams,
  body: reviewStatusBody,
  response: adminProductReview,
  errors: ['CATALOG_REVIEW_NOT_FOUND'],
  examples: [
    {
      name: 'hide',
      params: { id: '5001' },
      body: { status: 'hidden' },
      response: { ...adminProductReviewExample, status: 'hidden' },
    },
  ],
});

/** The list's 批量审核. One conditional update, so `updated` counts what actually moved. */
export const catalogAdminReviewBatchSetStatus = defineRoute({
  id: 'catalog.adminReviewBatchSetStatus',
  method: 'POST',
  path: '/admin-api/catalog/reviews/statuses',
  auth: 'admin',
  permission: 'catalog:review:write',
  summary: '批量审核商品评价',
  tags: ['catalog'],
  body: reviewBatchStatusBody,
  response: reviewBatchStatusResult,
  examples: [
    {
      name: 'publish-three',
      body: { reviewIds: ['5001', '5002', '5003'], status: 'published' },
      response: { updated: 3 },
    },
    {
      name: 'nothing-to-do',
      body: { reviewIds: ['5001'], status: 'published' },
      response: { updated: 0 },
    },
  ],
});

export const catalogAdminReviewDelete = defineRoute({
  id: 'catalog.adminReviewDelete',
  method: 'DELETE',
  path: '/admin-api/catalog/reviews/:id',
  auth: 'admin',
  permission: 'catalog:review:delete',
  summary: '删除商品评价',
  tags: ['catalog'],
  params: reviewParams,
  response: z.void(),
  status: 204,
  errors: ['CATALOG_REVIEW_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '5001' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

export const catalogProductReviews = defineRoute({
  id: 'catalog.productReviews',
  method: 'GET',
  path: '/api/v1/catalog/products/:id/reviews',
  auth: 'public',
  summary: '商品评价列表',
  tags: ['catalog'],
  params: productParams,
  query: reviewListQuery,
  response: pagedReviews,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [
    {
      name: 'all',
      params: { id: '1' },
      query: { page: 1, pageSize: 10, rating: 'all' },
      response: { items: [productReviewExample], total: 1, page: 1, pageSize: 10 },
    },
    {
      name: 'with-images',
      params: { id: '1' },
      query: { page: 1, pageSize: 10, rating: 'images' },
      response: { items: [productReviewExample], total: 1, page: 1, pageSize: 10 },
    },
  ],
});

/** The counts above the review list. */
export const catalogProductReviewSummary = defineRoute({
  id: 'catalog.productReviewSummary',
  method: 'GET',
  path: '/api/v1/catalog/products/:id/review-summary',
  auth: 'public',
  summary: '商品评价统计',
  tags: ['catalog'],
  params: productParams,
  response: reviewSummary,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: reviewSummaryExample }],
});

/**
 * The shopper writes one.
 *
 * Keyed on the **order line**, not the product: `product_reviews_order_item_uq`
 * is what makes "one review per purchased line" true under a double tap, and
 * the refusal comes from the insert rather than a prior SELECT.
 */
export const catalogReviewSubmit = defineRoute({
  id: 'catalog.reviewSubmit',
  method: 'POST',
  path: '/api/v1/catalog/reviews',
  auth: 'user',
  summary: '发表商品评价',
  tags: ['catalog'],
  body: reviewSubmitBody,
  response: submittedReview,
  status: 201,
  errors: [
    'CATALOG_REVIEW_NOT_ALLOWED',
    'CATALOG_REVIEW_ALREADY_WRITTEN',
    'CATALOG_REVIEW_IMAGE_NOT_ALLOWED',
  ],
  examples: [
    {
      name: 'ok',
      body: {
        orderItemId: '9101',
        productScore: 5,
        serviceScore: 5,
        content: '料子很舒服，洗了不变形。',
        images: ['https://cdn.example.com/r/5001-1.png'],
      },
      response: {
        ...productReviewExample,
        replyContent: null,
        replyAt: null,
        moderation: 'published',
      },
    },
    {
      name: 'held-for-moderation',
      body: {
        orderItemId: '9102',
        productScore: 5,
        serviceScore: 5,
        content: '很满意，包装私密。',
        images: [],
      },
      response: {
        ...productReviewExample,
        content: '很满意，包装私密。',
        images: [],
        replyContent: null,
        replyAt: null,
        moderation: 'pending',
      },
    },
  ],
});

/** The shopper's own reviews, for 我的评价. */
export const catalogMyReviews = defineRoute({
  id: 'catalog.myReviews',
  method: 'GET',
  path: '/api/v1/me/reviews',
  auth: 'user',
  summary: '我的商品评价',
  tags: ['catalog'],
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
  response: pagedReviews.extend({
    items: z.array(
      productReview.extend({
        productId: id,
        productName: z.string(),
        productImageUrl: z.string(),
        /**
         * The shopper's own list includes reviews still waiting (`pending`, 评价需审核 or
         * 内容安全) and ones an operator hid; the client says so neutrally
         * (「审核后展示」), never as an error. Nobody else ever sees those two.
         */
        status: productReviewStatus,
      }),
    ),
  }),
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [
          {
            ...productReviewExample,
            productId: '1',
            productName: '经典白T恤',
            productImageUrl: 'https://cdn.example.com/p/1.png',
            status: 'published',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
    {
      name: 'held-and-hidden',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [
          {
            ...productReviewExample,
            id: '5002',
            replyContent: null,
            replyAt: null,
            productId: '1',
            productName: '经典白T恤',
            productImageUrl: 'https://cdn.example.com/p/1.png',
            status: 'pending',
          },
          {
            ...productReviewExample,
            id: '5003',
            productId: '2',
            productName: '纯棉毛巾',
            productImageUrl: 'https://cdn.example.com/p/2.png',
            status: 'hidden',
          },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});
