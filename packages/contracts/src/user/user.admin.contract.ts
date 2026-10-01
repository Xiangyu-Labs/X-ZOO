import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  adminUserBatchGroupBody,
  adminUserBatchLabelBody,
  adminUserCreateBody,
  adminUserDetail,
  adminUserDetailExample,
  adminUserForm,
  adminUserListItemExample,
  adminUserListQuery,
  adminUserPasswordBody,
  adminUserStatusBody,
  batchResult,
  cancellationListQuery,
  cancellationRemarkBody,
  cancellationRequest,
  cancellationRequestExample,
  cancellationReviewBody,
  pagedAdminUsers,
  pagedCancellationRequests,
  userAddress,
  userAddressExample,
} from './schemas';

/**
 * 用户管理, `/admin-api/users` and `/admin-api/user-cancellations`.
 *
 * The detail screen's 订单 and 优惠券 tabs are **not** routes here: they are
 * `GET /admin-api/orders?userId=` and `GET /admin-api/user-coupons?userId=`,
 * owned by the order and coupon domains. Adding a `users/:id/orders` route
 * would mean this domain reading `orders`, which the import boundary forbids
 * and which would break every time the order list changed a column. 地址 is
 * here because addresses are this domain's own table.
 *
 * Granting a coupon from the user page is `POST /admin-api/coupons/:id/grants`
 * — coupon's own route, coupon's own permission.
 */

export const userAdminList = defineRoute({
  id: 'user.adminList',
  method: 'GET',
  path: '/admin-api/users',
  auth: 'admin',
  permission: 'user:customer:read',
  summary: '用户列表',
  tags: ['user'],
  query: adminUserListQuery,
  response: pagedAdminUsers,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: { items: [adminUserListItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'filtered',
      query: {
        page: 1,
        pageSize: 20,
        keyword: '13800',
        groupId: '3',
        status: 'active',
        registerSource: 'h5',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
      response: { items: [adminUserListItemExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const userAdminCreate = defineRoute({
  id: 'user.adminCreate',
  method: 'POST',
  path: '/admin-api/users',
  auth: 'admin',
  permission: 'user:customer:write',
  summary: '新增用户',
  tags: ['user'],
  body: adminUserCreateBody,
  response: adminUserDetail,
  errors: ['USER_PHONE_TAKEN', 'USER_GROUP_NOT_FOUND', 'USER_LABEL_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      body: {
        phone: '13800138000',
        nickname: '小明',
        adminRemark: '门店老客，电话下单',
        groupIds: ['3'],
        labelIds: [],
      },
      response: { ...adminUserDetailExample, registerSource: 'admin' },
    },
  ],
});

export const userAdminDetail = defineRoute({
  id: 'user.adminDetail',
  method: 'GET',
  path: '/admin-api/users/:id',
  auth: 'admin',
  permission: 'user:customer:read',
  summary: '用户详情',
  tags: ['user'],
  params: z.object({ id }),
  response: adminUserDetail,
  errors: ['USER_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1001' }, response: adminUserDetailExample }],
});

export const userAdminUpdate = defineRoute({
  id: 'user.adminUpdate',
  method: 'PUT',
  path: '/admin-api/users/:id',
  auth: 'admin',
  permission: 'user:customer:write',
  summary: '编辑用户',
  tags: ['user'],
  params: z.object({ id }),
  body: adminUserForm,
  response: adminUserDetail,
  errors: ['USER_NOT_FOUND', 'USER_BATCH_TARGET_UNKNOWN'],
  examples: [
    {
      name: 'ok',
      params: { id: '1001' },
      body: {
        nickname: '小明',
        adminRemark: 'VIP，来电优先接',
        groupIds: ['3'],
        labelIds: ['7'],
      },
      response: { ...adminUserDetailExample, adminRemark: 'VIP，来电优先接' },
    },
  ],
});

/**
 * 启用 / 禁用.
 *
 * Disabling bumps `password_version`, which kills every live token of that
 * account on its next request. Flipping `status` alone would leave the token
 * working until it expired — up to 30 days of a "banned" customer ordering
 * normally.
 */
export const userAdminSetStatus = defineRoute({
  id: 'user.adminSetStatus',
  method: 'POST',
  path: '/admin-api/users/:id/status',
  auth: 'admin',
  permission: 'user:customer:status',
  summary: '启用/禁用用户',
  tags: ['user'],
  params: z.object({ id }),
  body: adminUserStatusBody,
  response: adminUserDetail,
  errors: ['USER_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '1001' },
      body: { status: 'disabled' },
      response: { ...adminUserDetailExample, status: 'disabled' },
    },
  ],
});

export const userAdminResetPassword = defineRoute({
  id: 'user.adminResetPassword',
  method: 'POST',
  path: '/admin-api/users/:id/password',
  auth: 'admin',
  permission: 'user:customer:password',
  summary: '重置用户密码',
  tags: ['user'],
  params: z.object({ id }),
  body: adminUserPasswordBody,
  response: z.object({ ok: z.literal(true), revokedSessions: z.number().int().min(0) }),
  errors: ['USER_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '1001' },
      body: { password: 'xzoo654321' },
      response: { ok: true, revokedSessions: 2 },
    },
  ],
});

export const userAdminAddressList = defineRoute({
  id: 'user.adminAddressList',
  method: 'GET',
  path: '/admin-api/users/:id/addresses',
  auth: 'admin',
  permission: 'user:customer:read',
  summary: '用户收货地址',
  tags: ['user'],
  params: z.object({ id }),
  response: z.object({ items: z.array(userAddress) }),
  errors: ['USER_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1001' }, response: { items: [userAddressExample] } }],
});

/**
 * Batch group / label assignment from the list's checkbox selection.
 *
 * `mode` exists because 批量打标签 almost always means "add this label to these
 * 200 people"; if it always replaced the whole set, an operator tagging a
 * campaign would silently strip every other label from every selected customer.
 */
export const userAdminBatchSetGroups = defineRoute({
  id: 'user.adminBatchSetGroups',
  method: 'POST',
  path: '/admin-api/users/group-assignments',
  auth: 'admin',
  permission: 'user:customer:write',
  summary: '批量设置用户分组',
  tags: ['user'],
  body: adminUserBatchGroupBody,
  response: batchResult,
  errors: ['USER_BATCH_TARGET_UNKNOWN'],
  examples: [
    {
      name: 'replace',
      body: { userIds: ['1001', '1002'], groupIds: ['3'], mode: 'replace' },
      response: { affected: 2 },
    },
  ],
});

export const userAdminBatchSetLabels = defineRoute({
  id: 'user.adminBatchSetLabels',
  method: 'POST',
  path: '/admin-api/users/label-assignments',
  auth: 'admin',
  permission: 'user:customer:write',
  summary: '批量设置用户标签',
  tags: ['user'],
  body: adminUserBatchLabelBody,
  response: batchResult,
  errors: ['USER_BATCH_TARGET_UNKNOWN'],
  examples: [
    {
      name: 'add',
      body: { userIds: ['1001', '1002'], labelIds: ['7'], mode: 'add' },
      response: { affected: 2 },
    },
  ],
});

// ---------------------------------------------------------------------------
// cancellation review
// ---------------------------------------------------------------------------

export const userAdminCancellationList = defineRoute({
  id: 'user.adminCancellationList',
  method: 'GET',
  path: '/admin-api/user-cancellations',
  auth: 'admin',
  permission: 'user:cancellation:read',
  summary: '注销申请列表',
  tags: ['user'],
  query: cancellationListQuery,
  response: pagedCancellationRequests,
  examples: [
    {
      name: 'pending',
      query: { page: 1, pageSize: 20, status: 'pending' },
      response: { items: [cancellationRequestExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * Approve.
 *
 * Anonymises the `users` row — account replaced by a synthetic handle, phone,
 * nickname, avatar, real name and remark cleared, `deleted_at` set — bumps
 * `password_version` and revokes every session. It never deletes the row:
 * orders, refunds and invoices reference the id, and a hard delete would either
 * cascade a customer's purchase history away or fail on a foreign key at 2am.
 */
export const userAdminApproveCancellation = defineRoute({
  id: 'user.adminApproveCancellation',
  method: 'POST',
  path: '/admin-api/user-cancellations/:id/approval',
  auth: 'admin',
  permission: 'user:cancellation:review',
  summary: '通过注销申请',
  tags: ['user'],
  params: z.object({ id }),
  body: cancellationReviewBody,
  response: cancellationRequest,
  errors: ['USER_CANCELLATION_NOT_FOUND', 'USER_CANCELLATION_NOT_PENDING'],
  examples: [
    {
      name: 'ok',
      params: { id: '31' },
      body: { remark: '已核对无未完成订单' },
      response: {
        ...cancellationRequestExample,
        status: 'approved',
        reviewRemark: '已核对无未完成订单',
        reviewedAt: '2026-09-02T10:00:00+08:00',
      },
    },
  ],
});

export const userAdminRejectCancellation = defineRoute({
  id: 'user.adminRejectCancellation',
  method: 'POST',
  path: '/admin-api/user-cancellations/:id/rejection',
  auth: 'admin',
  permission: 'user:cancellation:review',
  summary: '拒绝注销申请',
  tags: ['user'],
  params: z.object({ id }),
  body: cancellationReviewBody,
  response: cancellationRequest,
  errors: ['USER_CANCELLATION_NOT_FOUND', 'USER_CANCELLATION_NOT_PENDING'],
  examples: [
    {
      name: 'ok',
      params: { id: '31' },
      body: { remark: '尚有进行中的订单' },
      response: {
        ...cancellationRequestExample,
        status: 'rejected',
        reviewRemark: '尚有进行中的订单',
        reviewedAt: '2026-09-02T10:00:00+08:00',
      },
    },
  ],
});

/** A note an operator leaves while still deciding. Does not change the status. */
export const userAdminRemarkCancellation = defineRoute({
  id: 'user.adminRemarkCancellation',
  method: 'POST',
  path: '/admin-api/user-cancellations/:id/remark',
  auth: 'admin',
  permission: 'user:cancellation:review',
  summary: '注销申请备注',
  tags: ['user'],
  params: z.object({ id }),
  body: cancellationRemarkBody,
  response: cancellationRequest,
  errors: ['USER_CANCELLATION_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '31' },
      body: { remark: '已联系客户确认' },
      response: { ...cancellationRequestExample, reviewRemark: '已联系客户确认' },
    },
  ],
});
