import type { NotificationChannelOutcome } from '@shop/contracts/notification/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * Labels shared by the two notification pages.
 *
 * They live in one file rather than next to each page because the send log and
 * the template list name the same things, and two lists of Chinese labels for
 * one enum drift within a month.
 */

export const NOTIFICATION_AUDIENCE: StatusMap<'user' | 'admin'> = {
  user: { label: '顾客', color: 'blue' },
  admin: { label: '管理员', color: 'purple' },
};

export const NOTIFICATION_CHANNEL: StatusMap<'inApp' | 'wechatOa' | 'wechatMini' | 'sms'> = {
  inApp: { label: '站内信', color: 'default' },
  wechatOa: { label: '公众号', color: 'green' },
  wechatMini: { label: '小程序', color: 'cyan' },
  sms: { label: '短信', color: 'orange' },
};

/**
 * The three states a send can be in, as the ledger reports them.
 *
 * `pending` covers "queued" and "waiting for its next attempt" on purpose: the
 * difference is a timestamp the operator can read in the row, and two tags for
 * one situation invite the question "which one is bad?".
 *
 * `done` is 已完成, not 已发送: the ledger is finished with the row, which it
 * also is when every channel was skipped. What went out is the 渠道 column's.
 */
export const NOTIFICATION_LOG_STATUS: StatusMap<'pending' | 'done' | 'unknown'> = {
  pending: { label: '待发送', color: 'processing' },
  done: { label: '已完成', color: 'success' },
  unknown: { label: '需要处理', color: 'error' },
};

/** What one channel of one send did. The row's `note` says why, on hover. */
export const NOTIFICATION_CHANNEL_OUTCOME: StatusMap<NotificationChannelOutcome> = {
  sent: { label: '已发送', color: 'success' },
  skipped: { label: '未发出', color: 'warning' },
  failed: { label: '失败', color: 'error' },
  unknown: { label: '未知', color: 'default' },
};
