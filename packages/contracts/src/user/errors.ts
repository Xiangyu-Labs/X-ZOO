import { defineErrors } from '../_conventions/errors';

/**
 * User error codes.
 *
 * One code per decision a caller can act on. "This address is not yours" and
 * "this address does not exist" are the same code and the same message on
 * purpose: telling the two apart turns the endpoint into an oracle for which
 * ids exist.
 *
 * The generic 401 / 403 / 404 / 422 / 429 cases come from `commonErrors`.
 */
export const userErrors = defineErrors({
  /** The customer does not exist, or an operator named an id that was cancelled. */
  USER_NOT_FOUND: { status: 404, message: '用户不存在' },
  /** 新增用户 with a phone number another account already holds. */
  USER_PHONE_TAKEN: { status: 409, message: '该手机号已注册' },
  /** Account disabled by an operator. Also raised when a live session's user is disabled. */
  USER_DISABLED: { status: 403, message: '账号已被禁用，请联系客服' },
  /**
   * `PUT /profile` with an `avatarUrl` that is not the current avatar, not the
   * shop's default avatar and not an image `POST /uploads` stored (USER-019).
   */
  USER_AVATAR_NOT_ALLOWED: { status: 422, message: '请上传头像图片后再保存' },
  /**
   * WeChat's 内容安全 (`msgSecCheck`) judged the new nickname `risky` (C09).
   * Only a mini-program account is checked; WeChat being unreachable lets the
   * nickname through (fail-open, see `wechat.sec-check.ts`).
   */
  USER_NICKNAME_REJECTED: { status: 422, message: '昵称包含不当信息，请修改后再保存' },

  /** Unknown id, somebody else's row, or already deleted. One code for all three. */
  USER_ADDRESS_NOT_FOUND: { status: 404, message: '收货地址不存在' },
  /** 20 live addresses per customer. */
  USER_ADDRESS_LIMIT_REACHED: { status: 409, message: '收货地址数量已达上限' },

  /** Unknown id, somebody else's title, or already deleted. One code for all three. */
  USER_INVOICE_TITLE_NOT_FOUND: { status: 404, message: '发票抬头不存在' },
  /** `INVOICE_TITLE_LIMIT` (20) live titles per customer. `details` carries `{ limit }`. */
  USER_INVOICE_TITLE_LIMIT_REACHED: { status: 409, message: '发票抬头数量已达上限' },
  /** WeChat's 内容安全 judged the title's name `risky` (C09); same rules as the nickname. */
  USER_INVOICE_TITLE_REJECTED: { status: 422, message: '发票抬头包含不当信息，请修改后再保存' },

  /** A cancellation request is already open; the customer withdraws it or waits. */
  USER_CANCELLATION_PENDING: { status: 409, message: '您已提交过注销申请，请等待审核' },
  USER_CANCELLATION_NOT_FOUND: { status: 404, message: '注销申请不存在' },
  /**
   * The request was already approved, rejected or withdrawn. Raised by a review
   * whose conditional update affected zero rows, so it covers every already-
   * decided state without a second read that could itself be stale.
   */
  USER_CANCELLATION_NOT_PENDING: { status: 409, message: '该注销申请已处理' },

  /** `user_groups_name_uq` / `user_labels_name_uq` / `user_label_categories_name_uq`. */
  USER_GROUP_NAME_TAKEN: { status: 409, message: '分组名称已存在' },
  USER_GROUP_NOT_FOUND: { status: 404, message: '用户分组不存在' },
  USER_LABEL_NAME_TAKEN: { status: 409, message: '标签名称已存在' },
  USER_LABEL_NOT_FOUND: { status: 404, message: '用户标签不存在' },
  USER_LABEL_CATEGORY_NAME_TAKEN: { status: 409, message: '标签分类名称已存在' },
  USER_LABEL_CATEGORY_NOT_FOUND: { status: 404, message: '标签分类不存在' },
  /** A batch named ids that do not exist. `details` carries `{ ids }`. */
  USER_BATCH_TARGET_UNKNOWN: { status: 422, message: '部分选项不存在，请刷新后重试' },
});

export type UserErrorCode = keyof typeof userErrors;
