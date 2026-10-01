import type {
  CancellationStatus,
  UserRegisterSource,
  UserStatus,
} from '@shop/contracts/user/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The enums the four user pages share, spelled once.
 *
 * Each map is keyed by its contract union, so a value the contract does not
 * have is a compile error rather than a tag that renders the raw string.
 * `statusOptions(map)` from the kit turns any of them into filter options, so
 * the filter bar and the tag can never disagree about the labels.
 */

export const USER_STATUS: StatusMap<UserStatus> = {
  active: { label: '正常', color: 'success' },
  disabled: { label: '已禁用', color: 'error' },
};

export const REGISTER_SOURCE: StatusMap<UserRegisterSource> = {
  h5: { label: 'H5', color: 'default' },
  wechat_oa: { label: '公众号', color: 'green' },
  wechat_mini: { label: '小程序', color: 'blue' },
  admin: { label: '后台录入', color: 'purple' },
};

export const CANCELLATION_STATUS: StatusMap<CancellationStatus> = {
  pending: { label: '待审核', color: 'processing' },
  approved: { label: '已通过', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
  withdrawn: { label: '已撤回', color: 'default' },
};
