'use client';

import type {
  GroupbuyActivityStatus,
  GroupbuyGroupStatus,
  GroupbuyMemberRole,
  GroupbuyMemberStatus,
} from '@shop/contracts/groupbuy/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The group-buy domain's enums, in one file next to the pages.
 *
 * One `StatusMap` per enum, shared by the table column and the filter bar, so a
 * label can never say 进行中 in one place and 已启用 in another. The keys are the
 * contract's own union members, so deleting a value from the contract is a
 * compile error here rather than a blank tag in production.
 */

export const GROUPBUY_ACTIVITY_STATUS: StatusMap<GroupbuyActivityStatus> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'success' },
  paused: { label: '已暂停', color: 'warning' },
  ended: { label: '已结束', color: 'default' },
};

export const GROUPBUY_GROUP_STATUS: StatusMap<GroupbuyGroupStatus> = {
  forming: { label: '拼团中', color: 'processing' },
  succeeded: { label: '已成团', color: 'success' },
  failed: { label: '未成团', color: 'error' },
  cancelled: { label: '已取消', color: 'default' },
};

export const GROUPBUY_MEMBER_STATUS: StatusMap<GroupbuyMemberStatus> = {
  joined: { label: '参团中', color: 'processing' },
  refunded: { label: '已退款', color: 'warning' },
  cancelled: { label: '已取消', color: 'default' },
};

export const GROUPBUY_MEMBER_ROLE: StatusMap<GroupbuyMemberRole> = {
  leader: { label: '团长', color: 'gold' },
  member: { label: '团员', color: 'default' },
};

/** A `StatusMap` as `<Select>` options, so a filter can never drift from a tag. */
export const optionsOf = <K extends string>(map: StatusMap<K>) =>
  (Object.keys(map) as K[]).map((value) => ({ label: map[value].label, value }));
