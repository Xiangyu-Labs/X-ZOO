import { defineErrors } from '../_conventions/errors';

/**
 * Group-buy error codes.
 *
 * One code per decision the caller can act on, not per internal branch. Losing
 * a race — the last seat, the last unit of activity stock — is a 409, because
 * two shoppers tapping 参与拼团 at the same instant is ordinary traffic.
 *
 * `GROUPBUY_GROUP_NOT_JOINABLE` deliberately covers full / expired / already
 * succeeded / failed / cancelled: the join learns "no" from a conditional read
 * of a row that may have moved again by the time anybody asked why, so naming
 * the reason would be a guess dressed up as a fact.
 */
export const groupbuyErrors = defineErrors({
  /** The activity id does not exist, is soft-deleted, or is not visible to shoppers. */
  GROUPBUY_ACTIVITY_NOT_FOUND: { status: 404, message: '拼团活动不存在或已下架' },
  /** The activity exists but is `draft` / `paused` / `ended`, or `now` is outside its window. */
  /**
   * An edit changed a stock that orders moved since the form was opened.
   * `details` carries `{ skuId?, expected, current }` (no `skuId`: the activity's own stock).
   */
  GROUPBUY_STOCK_CHANGED: {
    status: 409,
    message: '库存在你编辑期间已被订单改动，请刷新后重新填写库存',
  },
  /** Editing an `ended` 拼团 activity back to life. It is copied, not re-opened. */
  GROUPBUY_ACTIVITY_ENDED: { status: 409, message: '已结束的活动不能重新开启，请复制一个新活动' },
  /**
   * The edit removes an activity SKU that has sold units or a live order (RISK-D-012). It can be
   * switched off (`isEnabled: false`) instead. `details: { skuIds }`.
   */
  GROUPBUY_ACTIVITY_SKU_IN_USE: { status: 409, message: '该规格已有订单，不能移除，可改为停用' },
  GROUPBUY_ACTIVITY_NOT_OPEN: { status: 409, message: '该拼团活动当前不可参与' },
  /** The order's lines are not the activity's product, or name a SKU the activity does not sell. */
  GROUPBUY_SKU_NOT_IN_ACTIVITY: { status: 422, message: '所选规格不参与该拼团活动' },
  /** `perOrderQuantity`, or a line quantity of a second product in the same order. */
  GROUPBUY_QUANTITY_NOT_ALLOWED: { status: 422, message: '拼团订单的购买数量不符合活动限制' },
  /** The conditional decrement of the activity's own stock affected zero rows (STOCK-004). */
  GROUPBUY_OUT_OF_STOCK: { status: 409, message: '拼团商品库存不足' },

  /** The group id does not exist, or belongs to another activity. */
  GROUPBUY_GROUP_NOT_FOUND: { status: 404, message: '该团不存在' },
  /** Full, expired, already succeeded, failed or cancelled. See the note above. */
  GROUPBUY_GROUP_NOT_JOINABLE: { status: 409, message: '该团已满或已结束，换一个团试试' },
  /** `groupbuy_members_group_user_uq` refused the insert: one shopper, one seat, one team. */
  GROUPBUY_ALREADY_IN_GROUP: { status: 409, message: '您已经参与过该团' },
  /** 取消拼团: only the leader of a group nobody has paid into may withdraw it. */
  GROUPBUY_GROUP_NOT_WITHDRAWABLE: { status: 409, message: '该团已有成员付款，无法取消' },

  /** 立即成团 on a group that is not `forming`, or that nobody has paid into yet. */
  GROUPBUY_GROUP_NOT_COMPLETABLE: { status: 409, message: '该团当前无法手动成团' },
  /** 立即成团 on an under-filled group: the shop never invents members (虚拟成团 is off for good). */
  GROUPBUY_VIRTUAL_FILL_DISABLED: {
    status: 409,
    message: '本店不支持虚拟成团，未满员的团不能立即成团',
  },

  /** Deleting an activity that still has forming groups or live orders. */
  GROUPBUY_ACTIVITY_IN_USE: { status: 409, message: '该活动还有进行中的团，无法删除' },
  /**
   * The order was priced without the activity's group price.
   *
   * Fails closed. The group price is taken off by a `PricingContributor` in
   * checkout's pricing pass, which this domain does not own; if that adjustment
   * is missing or the written lines charge more than the activity price, the
   * order is refused. Selling at the wrong price is worse than refusing.
   */
  GROUPBUY_PRICE_NOT_APPLIED: { status: 409, message: '拼团价未生效，请稍后重试' },
});

export type GroupbuyErrorCode = keyof typeof groupbuyErrors;
