/**
 * The catalog domain's public surface.
 *
 * `docs/conventions.md`: "A domain in `core` may import another domain only
 * through that domain's `index.ts`." So this file is the contract between the
 * catalog and the rest of the system. `catalog.repo.ts` in particular is
 * private: no other domain may read a product table directly, and none needs
 * to.
 *
 * ## What other domains call
 *
 * | Function / export        | Caller                   | When                                               |
 * | ------------------------ | ------------------------ | -------------------------------------------------- |
 * | `getSkuForSale`          | checkout                 | pricing the cart, confirming and creating an order |
 * | `checkPurchaseAllowance` | checkout                 | 起购 / 限购, inside the order transaction          |
 * | `recordCartAdd`          | cart                     | 加购件数, inside the cart's add transaction        |
 * | `getStockPort()`         | order, refund, marketing | reserve, commit, release — via `order/ports.ts`    |
 * | `getCatalogPort()`       | cart, checkout           | the batch cart read, via `order/catalog.port.ts`   |
 * | `productCardsFor`        | cms                      | rendering the related product under an article     |
 * | `ProductCard`            | everyone                 | the one product-card DTO; add fields, do not fork  |
 * | `catalogPermissions`     | system                   | the permission tree and the admin menu             |
 * | `catalogConfig`          | system                   | the 商品设置 config group                          |
 * | `runAutoReview`          | worker                   | the 系统默认好评 sweep                             |
 * | `pruneBrowseHistory`     | worker                   | the 足迹 retention sweep                           |
 * | `foldProductViews`       | worker                   | folding view events into `products.views`          |
 *
 * `checkPurchaseAllowance` and `recordCartAdd` take `(tx, …)` — a
 * transaction the *caller* owns — matching `recordEffect(tx, ctx, input)`, the
 * platform's other "join the transaction you are already in" primitive.
 *
 * ## What importing this file registers
 *
 * Importing `@shop/core/catalog` registers the `StockPort` (from
 * `catalog.stock.ts`), the `CatalogPort` the cart and checkout read variants
 * through (from `catalog.sale.ts`) and the 商品设置 config group. The two ports
 * go through `registerCatalogDomain()`, the idempotent shape
 * `@shop/core/domains` looks for, so a test that `resetOrderPorts()` can put
 * them back with one call. (The `OrderFactsPort` the catalog asks about
 * purchases is the order domain's to register.)
 *
 * ## Virtual cards: catalog imports them, the order domain hands them out
 *
 * The 卡密 pool is catalog's (`adminVirtualCard*`: import, list, void, and the
 * stock derived from the pool). Handing a card to a paid order line is the
 * order domain's: `order.fulfil.repo.ts::claimVirtualCard`, called by
 * `autoDeliver` on `order.paid`, is the one atomic claim and the one MUT-001
 * mutates. Catalog carries no second copy, so nobody can fix one and believe
 * delivery changed.
 */

import { registerCatalogPort } from '../order';
import { registerStockPort } from '../order/ports';
import { registerMediaRiskHandler, registerMediaUncheckedHandler } from '../wechat';
import { onAccountCancelled } from '../user';
import {
  forgetReviewAuthor,
  hideRiskyReviewImage,
  holdUncheckedReview,
} from './catalog.review.service';
import { catalogSalePort } from './catalog.sale';
import { catalogStockPort } from './catalog.stock';
// The config group registers itself on import.
import './catalog.config';

/** Registers the stock and sale ports; called once on import, again after a reset. */
export function registerCatalogDomain(): void {
  registerStockPort(catalogStockPort);
  registerCatalogPort(catalogSalePort);
  // 内容安全: a review picture WeChat calls risky comes off the review (C09).
  registerMediaRiskHandler('review_image', hideRiskyReviewImage);
  // …and one WeChat cannot check puts the review back in 待审核 (CONTENT-006).
  registerMediaUncheckedHandler('review_image', holdUncheckedReview);
  // 注销: a cancelled shopper's reviews stay, without their name or face.
  onAccountCancelled('catalog', forgetReviewAuthor);
}

registerCatalogDomain();

export {
  // admin: categories
  adminCategoryCreate,
  adminCategoryDelete,
  adminCategoryDetail,
  adminCategoryList,
  adminCategorySetVisibility,
  adminCategoryTree,
  adminCategoryUpdate,
  // admin: products
  adminProductCreate,
  adminProductDelete,
  adminProductDetail,
  adminProductExport,
  adminProductList,
  adminProductRestore,
  adminProductSetStatus,
  adminProductUpdate,
  adminSkuMatrix,
  adminStockWarnings,
  // admin: virtual cards
  adminVirtualCardImport,
  adminVirtualCardList,
  adminVirtualCardVoid,
  // the domain API other domains call
  checkPurchaseAllowance,
  getSkuForSale,
  productCardsFor,
  recordCartAdd,
  // shared mappers, for the other catalog service files and the tests
  toProductCard,
} from './catalog.service';

export type { SaleableSku } from './catalog.service';

export {
  adminLabelCategoryCreate,
  adminLabelCategoryDelete,
  adminLabelCategoryList,
  adminLabelCategoryUpdate,
  adminLabelCreate,
  adminLabelDelete,
  adminLabelList,
  adminLabelSetEnabled,
  adminLabelUpdate,
  adminParamTemplateCreate,
  adminParamTemplateDelete,
  adminParamTemplateList,
  adminParamTemplateSetEnabled,
  adminParamTemplateUpdate,
  adminProtectionCreate,
  adminProtectionDelete,
  adminProtectionList,
  adminProtectionSetEnabled,
  adminProtectionUpdate,
} from './catalog.taxonomy.service';

export {
  adminReviewBatchSetStatus,
  adminReviewCreate,
  adminReviewDelete,
  adminReviewList,
  adminReviewReply,
  adminReviewReplyUpdate,
  adminReviewSetStatus,
  myReviews,
  productReviewSummary,
  productReviews,
  reviewSubmit,
  runAutoReview,
} from './catalog.review.service';

export type { AutoReviewResult } from './catalog.review.service';

export {
  categoryTree,
  clearSearchHistory,
  favoriteAdd,
  favoriteAddBatch,
  favoriteList,
  favoriteRemove,
  favoriteRemoveBatch,
  historyClear,
  historyList,
  historyRemove,
  hotKeywords,
  productDetail,
  productList,
  productSkus,
  pruneBrowseHistory,
  searchHistory,
} from './catalog.storefront.service';

/**
 * The stock port, also reachable as `getStockPort()`. The refund path is
 * `release(tx, orderId, lines, { committed: true, refundId })`; there is no
 * separate release for sold units.
 */
export { catalogStockPort } from './catalog.stock';

/** The batch cart read, also reachable as `resolveCatalogPort()`. */
export { catalogSalePort } from './catalog.sale';

/** 商品浏览量: the worker folds `product_events` views into `products.views`. */
export { foldProductViews, VIEW_WATERMARK_KEY } from './catalog.views';
export type { FoldViewsOptions, FoldViewsReport } from './catalog.views';

/** The 商品设置 group. Registered by importing this file. */
export { catalogConfig } from './catalog.config';

export { catalogPermissions } from './permissions';

/** Test helper for the domains that move stock through the port (order, refund). */
export { stockAndSalesOf } from './catalog.repo';

/** Pure rules, re-exported for the domains that render the same numbers. */
export {
  canAddToCart,
  chargesFreight,
  checkPurchaseLimit,
  salesDisplay,
  skuMatrix,
  specTextOf,
  summariseReviews,
} from './catalog.rules';
