'use client';

import type {
  PresaleActivityStatus,
  PresaleOrderStage,
  PresalePaymentMode,
} from '@shop/contracts/presale/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The presale domain's enums, in one file next to the pages.
 *
 * One `StatusMap` per enum, shared by the table column and the filter bar, so a
 * label can never say 进行中 in one place and 已启用 in another. The keys are the
 * contract's own union members, so deleting a value from the contract is a
 * compile error here rather than a blank tag in production.
 */

export const PRESALE_ACTIVITY_STATUS: StatusMap<PresaleActivityStatus> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'success' },
  paused: { label: '已暂停', color: 'warning' },
  ended: { label: '已结束', color: 'default' },
};

export const PRESALE_PAYMENT_MODE: StatusMap<PresalePaymentMode> = {
  full: { label: '全款预售', color: 'blue' },
  // Present because migrated data can carry it and the admin must not render a
  // blank tag; no route ever creates one (`PRESALE_DEPOSIT_NOT_SUPPORTED`).
  deposit: { label: '定金预售（不支持）', color: 'error' },
};

/**
 * The stage machine of `presale_orders`.
 *
 * Four of the six are unreachable in a full-payment shop and say so, because an
 * operator looking at historical orders will see them and the honest answer is
 * "this is a historical order", not a blank cell.
 */
export const PRESALE_ORDER_STAGE: StatusMap<PresaleOrderStage> = {
  deposit_pending: { label: '待付定金（历史）', color: 'default' },
  deposit_paid: { label: '已付定金（历史）', color: 'default' },
  final_pending: { label: '待付款', color: 'processing' },
  final_paid: { label: '已付款', color: 'success' },
  expired: { label: '已过期', color: 'default' },
  cancelled: { label: '已取消/已退款', color: 'error' },
};
