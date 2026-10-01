import { defineErrors } from '../_conventions/errors';

/**
 * Presale error codes.
 *
 * Full-payment presale only. `PRESALE_DEPOSIT_NOT_SUPPORTED` exists because the
 * schema carries the deposit columns (SCHEMA.md §6.3) and the admin form can
 * still be made to send `paymentMode: 'deposit'`: the refusal is explicit, so
 * nobody ships a half-built deposit flow by accident.
 */
export const presaleErrors = defineErrors({
  /** The activity id does not exist, is soft-deleted, or is not visible to shoppers. */
  PRESALE_ACTIVITY_NOT_FOUND: { status: 404, message: '预售活动不存在或已下架' },
  /** The activity exists but is `draft` / `paused` / `ended`, or `now` is outside its sale window. */
  /**
   * An edit changed a stock that orders moved since the form was opened.
   * `details` carries `{ skuId?, expected, current }` (no `skuId`: the activity's own stock).
   */
  PRESALE_STOCK_CHANGED: {
    status: 409,
    message: '库存在你编辑期间已被订单改动，请刷新后重新填写库存',
  },
  /** Editing an `ended` 预售 activity back to life. It is copied, not re-opened. */
  PRESALE_ACTIVITY_ENDED: { status: 409, message: '已结束的活动不能重新开启，请复制一个新活动' },
  /**
   * The edit removes an activity SKU that orders point at (RISK-D-012). It can be switched
   * off (`isEnabled: false`) instead. `details: { skuIds }`.
   */
  PRESALE_ACTIVITY_SKU_IN_USE: { status: 409, message: '该规格已有订单，不能移除，可改为停用' },
  PRESALE_ACTIVITY_NOT_OPEN: { status: 409, message: '该预售活动当前不可购买' },
  /** The order's lines are not the activity's product, or name a SKU the activity does not sell. */
  PRESALE_SKU_NOT_IN_ACTIVITY: { status: 422, message: '所选规格不参与该预售活动' },
  /** `perOrderQuantity`, or more than one product in a presale order. */
  PRESALE_QUANTITY_NOT_ALLOWED: { status: 422, message: '预售订单的购买数量不符合活动限制' },
  /** The conditional decrement of the activity's own stock affected zero rows (STOCK-004). */
  PRESALE_OUT_OF_STOCK: { status: 409, message: '预售商品库存不足' },
  /** Deleting an activity that still has live presale orders. */
  PRESALE_ACTIVITY_IN_USE: { status: 409, message: '该活动还有未完成的订单，无法删除' },
  /** The deposit half of the schema is inert. See the note above. */
  PRESALE_DEPOSIT_NOT_SUPPORTED: { status: 422, message: '暂不支持定金预售，请使用全款预售' },
  /**
   * The order was priced without the activity's presale price.
   *
   * Fails closed, for the same reason as `GROUPBUY_PRICE_NOT_APPLIED`: the
   * presale price is taken off by a `PricingContributor` this domain does not
   * own, and selling at the wrong price is worse than refusing.
   */
  PRESALE_PRICE_NOT_APPLIED: { status: 409, message: '预售价未生效，请稍后重试' },
});

export type PresaleErrorCode = keyof typeof presaleErrors;
