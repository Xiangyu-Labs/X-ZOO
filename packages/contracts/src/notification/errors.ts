import { defineErrors } from '../_conventions/errors';

/**
 * Notification error codes.
 *
 * There are few of them, and that is the design. Sending is never a
 * request/response operation — it happens behind the effects ledger after the
 * business transaction committed — so almost nothing a caller does can be
 * refused. What is left is the admin's template screen and the two inbox
 * surfaces, where a refusal really is a decision the caller can act on.
 *
 * Notice what is *not* here: no `NOTIFICATION_SEND_FAILED`. A failed send never
 * reaches an HTTP response, because a failed send must never fail an order, a
 * payment or a refund. It lands in the ledger, is retried with backoff, and
 * ends up in 通知发送记录 for a human.
 */
export const notificationErrors = defineErrors({
  /** The registry has no event with that code. Template codes are compiled in, not data. */
  NOTIFICATION_TEMPLATE_NOT_FOUND: { status: 404, message: '通知模板不存在' },
  /**
   * A channel was switched on with nothing to send: an OA template message
   * without a template id, SMS without a template code, in-app without a title.
   * The message names each channel and what it lacks; `details` carries
   * `{ problems: NotificationChannelProblem[] }`.
   */
  NOTIFICATION_CHANNEL_INCOMPLETE: { status: 422, message: '该渠道的配置不完整，无法启用' },
  /**
   * The channel is not one this template's audience can receive on. From a
   * save, the message names the channels and `details` carries `{ problems }`.
   */
  NOTIFICATION_CHANNEL_NOT_APPLICABLE: { status: 409, message: '该通知不支持此渠道' },
  /** The message does not exist, or belongs to somebody else. Same message either way. */
  NOTIFICATION_MESSAGE_NOT_FOUND: { status: 404, message: '消息不存在' },
  /** `unknown → pending` affected zero rows: already re-queued, or already done. */
  NOTIFICATION_LOG_NOT_RETRYABLE: { status: 409, message: '该发送记录当前无法重试' },
});

export type NotificationErrorCode = keyof typeof notificationErrors;
