import { defineErrors } from '../_conventions/errors';

/**
 * Catalog error codes.
 *
 * One code per *decision the caller can act on*, not one per internal branch.
 * `CATALOG_SKU_OUT_OF_STOCK` covers "gone entirely" and "fewer left than you
 * asked for" because the reservation learns "no" from an UPDATE that affected
 * zero rows and genuinely cannot tell which — and the shopper's next move is
 * the same either way.
 *
 * The generic 404/422/429 cases come from `commonErrors` and are not repeated.
 */
export const catalogErrors = defineErrors({
  // -- categories ----------------------------------------------------------
  CATALOG_CATEGORY_NOT_FOUND: { status: 404, message: '商品分类不存在' },
  /** The tree is capped at three levels; a fourth has nowhere to render. */
  CATALOG_CATEGORY_TOO_DEEP: { status: 422, message: '商品分类最多三级' },
  /** Moving a category under its own descendant would make a cycle. */
  CATALOG_CATEGORY_CYCLE: { status: 422, message: '不能把分类移动到它自己的下级分类下' },
  /** Children or live products still point at it; deleting it would orphan both. */
  CATALOG_CATEGORY_IN_USE: { status: 409, message: '该分类下还有子分类或商品，无法删除' },

  // -- products ------------------------------------------------------------
  CATALOG_PRODUCT_NOT_FOUND: { status: 404, message: '商品不存在或已下架' },
  /** `products_spu_uq`. An operator pasting a duplicate SPU should hear it as a field error. */
  CATALOG_PRODUCT_SPU_TAKEN: { status: 409, message: '该商品编码已被其他商品使用' },
  /**
   * The product is not on sale: draft, off the shelf, or soft-deleted. One code
   * on purpose — the storefront shows 已下架 for all three and must not leak
   * which, because "this exists but is hidden" is information about the shop.
   */
  CATALOG_PRODUCT_NOT_ON_SALE: { status: 409, message: '商品已下架' },
  /** Delete refused because the product is still referenced by an open order. */
  CATALOG_PRODUCT_IN_USE: { status: 409, message: '该商品还有未完成的订单，无法删除' },
  /** Restoring from the recycle bin, but it was never there. */
  CATALOG_PRODUCT_NOT_DELETED: { status: 409, message: '该商品不在回收站中' },

  // -- SKUs and stock ------------------------------------------------------
  CATALOG_SKU_NOT_FOUND: { status: 404, message: '所选规格不存在' },
  /** Reserved for the buyer: not enough left, or none at all. */
  CATALOG_SKU_OUT_OF_STOCK: { status: 409, message: '库存不足' },
  /**
   * The editor changed a SKU's stock, but orders moved it since the form was
   * opened (`expectedStock` no longer matches). `details` carries
   * `{ specText, expected, current }`.
   */
  CATALOG_SKU_STOCK_CHANGED: {
    status: 409,
    message: '库存在你编辑期间已被订单改动，请刷新后重新填写库存',
  },
  /**
   * The editor dropped a spec combination that orders, group buys or presales
   * still point at. `details` carries `{ specTexts }`. Hide it instead.
   */
  CATALOG_SKU_IN_USE: {
    status: 409,
    message: '该规格已有订单或活动引用，不能删除；可以把它设为不显示',
  },
  /** `products_purchase_limit_mode`. `details` carries `{ limit, mode }`. */
  CATALOG_PURCHASE_LIMIT_REACHED: { status: 409, message: '已达到该商品的限购数量' },
  /** Below `min_purchase_quantity`. `details` carries `{ minQuantity }`. */
  CATALOG_MIN_PURCHASE_NOT_MET: { status: 409, message: '未达到该商品的起购数量' },

  // -- virtual cards -------------------------------------------------------
  /** The SKU belongs to a product whose `kind` is not `virtual_card`. */
  CATALOG_NOT_A_CARD_PRODUCT: { status: 422, message: '只有卡密商品可以导入卡密' },

  // -- labels, params, protections -----------------------------------------
  CATALOG_LABEL_NOT_FOUND: { status: 404, message: '商品标签不存在' },
  CATALOG_LABEL_CATEGORY_NOT_FOUND: { status: 404, message: '标签分类不存在' },
  CATALOG_PARAM_TEMPLATE_NOT_FOUND: { status: 404, message: '商品参数不存在' },
  CATALOG_PROTECTION_NOT_FOUND: { status: 404, message: '商品保障服务不存在' },
  /** `product_labels_name_uq`, `product_param_templates_name_uq`, `product_protections_title_uq`. */
  CATALOG_NAME_TAKEN: { status: 409, message: '该名称已存在' },

  // -- reviews -------------------------------------------------------------
  CATALOG_REVIEW_NOT_FOUND: { status: 404, message: '评价不存在' },
  /**
   * `product_reviews_order_item_uq` refused the insert: this order line has
   * already been reviewed. A second tap is a duplicate submit, not an error the
   * shopper caused, so the message says so plainly.
   */
  CATALOG_REVIEW_ALREADY_WRITTEN: { status: 409, message: '该商品您已经评价过了' },
  /**
   * The order line is not the caller's, does not exist, or is not in a state
   * that may be reviewed. One code for the same reason `COUPON_NOT_USABLE` is
   * one code — telling a stranger which of the three it was leaks order data.
   */
  CATALOG_REVIEW_NOT_ALLOWED: { status: 409, message: '该订单暂时不能评价' },
  /**
   * A review picture that is not an image our own storage holds — what
   * `POST /api/v1/uploads` returned (CAT-018). A link to another server is
   * refused, as the avatar is (USER-019).
   */
  CATALOG_REVIEW_IMAGE_NOT_ALLOWED: { status: 422, message: '请上传评价图片后再提交' },
  /** Replying twice. The reply is an edit after that, not a second reply. */
  CATALOG_REVIEW_ALREADY_REPLIED: { status: 409, message: '该评价已经回复过了' },

  // -- export --------------------------------------------------------------
  /** The filtered set is larger than the export ceiling. `details` carries `{ total, limit }`. */
  CATALOG_EXPORT_TOO_LARGE: { status: 422, message: '导出数量超过上限，请缩小筛选范围' },
});

export type CatalogErrorCode = keyof typeof catalogErrors;
