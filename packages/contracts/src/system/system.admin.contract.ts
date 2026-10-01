import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  adminForm,
  adminListItem,
  adminListItemExample,
  adminListQuery,
  adminMutationResult,
  adminPasswordBody,
  adminSelfProfile,
  adminSelfProfileExample,
  adminStatusBody,
  pagedAdmins,
  passwordChangeResult,
  profileForm,
  profilePasswordBody,
} from './schemas';

/**
 * Admin accounts and the caller's own profile.
 *
 * Two permission families on purpose:
 *
 * - `/admin-api/admins/**` manages *other people* and needs `system:admin:*`.
 * - `/admin-api/profile/**` is the caller's own account. It declares the
 *   implicitly-granted `auth:profile:*` atoms so that an admin with no grants at
 *   all can still read their profile and change their own password — which is a
 *   precondition for the "password change revokes sessions" rule to be usable.
 */

const adminParams = z.object({ id });

export const systemAdminList = defineRoute({
  id: 'system.adminList',
  method: 'GET',
  path: '/admin-api/admins',
  auth: 'admin',
  permission: 'system:admin:read',
  summary: '管理员列表',
  tags: ['system'],
  query: adminListQuery,
  response: pagedAdmins,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [adminListItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'disabled-only',
      query: { page: 1, pageSize: 20, enabled: 'false' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const systemAdminDetail = defineRoute({
  id: 'system.adminDetail',
  method: 'GET',
  path: '/admin-api/admins/:id',
  auth: 'admin',
  permission: 'system:admin:read',
  summary: '管理员详情',
  tags: ['system'],
  params: adminParams,
  response: adminListItem,
  errors: ['SYSTEM_ADMIN_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: adminListItemExample }],
});

export const systemAdminCreate = defineRoute({
  id: 'system.adminCreate',
  method: 'POST',
  path: '/admin-api/admins',
  auth: 'admin',
  permission: 'system:admin:write',
  consoleOnly: true,
  summary: '新建管理员',
  tags: ['system'],
  body: adminForm,
  response: adminMutationResult,
  status: 201,
  errors: [
    'SYSTEM_ADMIN_ACCOUNT_TAKEN',
    'SYSTEM_ADMIN_PASSWORD_REQUIRED',
    'SYSTEM_ROLE_UNKNOWN',
    'SYSTEM_GRANT_EXCEEDS_OWN',
  ],
  examples: [
    {
      name: 'operator',
      body: {
        account: 'operator',
        name: '运营小王',
        password: 'xzoo-123456',
        phone: '13800000001',
        enabled: true,
        roleIds: ['2'],
      },
      response: {
        admin: {
          ...adminListItemExample,
          id: '3',
          account: 'operator',
          name: '运营小王',
          phone: '13800000001',
          isSuper: false,
          roleIds: ['2'],
          roleNames: ['运营'],
          lastLoginAt: null,
          createdAt: '2026-09-22T09:00:00+08:00',
        },
        revokedSessions: 0,
      },
    },
  ],
});

export const systemAdminUpdate = defineRoute({
  id: 'system.adminUpdate',
  method: 'PUT',
  path: '/admin-api/admins/:id',
  auth: 'admin',
  permission: 'system:admin:write',
  consoleOnly: true,
  summary: '编辑管理员',
  tags: ['system'],
  params: adminParams,
  body: adminForm,
  response: adminMutationResult,
  errors: [
    'SYSTEM_ADMIN_NOT_FOUND',
    'SYSTEM_ADMIN_ACCOUNT_TAKEN',
    'SYSTEM_ADMIN_SELF_LOCKOUT',
    'SYSTEM_ROLE_UNKNOWN',
    'SYSTEM_GRANT_EXCEEDS_OWN',
  ],
  examples: [
    {
      name: 'rename-and-set-password',
      params: { id: '3' },
      body: {
        account: 'operator',
        name: '运营小王（已转岗）',
        password: 'xzoo-654321',
        enabled: true,
        roleIds: ['2'],
      },
      response: {
        admin: {
          ...adminListItemExample,
          id: '3',
          account: 'operator',
          name: '运营小王（已转岗）',
          isSuper: false,
          roleIds: ['2'],
          roleNames: ['运营'],
        },
        // A password change always kills that admin's live sessions.
        revokedSessions: 2,
      },
    },
  ],
});

export const systemAdminSetStatus = defineRoute({
  id: 'system.adminSetStatus',
  method: 'POST',
  path: '/admin-api/admins/:id/status',
  auth: 'admin',
  permission: 'system:admin:write',
  consoleOnly: true,
  summary: '启用/停用管理员',
  tags: ['system'],
  params: adminParams,
  body: adminStatusBody,
  response: adminMutationResult,
  errors: ['SYSTEM_ADMIN_NOT_FOUND', 'SYSTEM_ADMIN_SELF_LOCKOUT', 'SYSTEM_GRANT_EXCEEDS_OWN'],
  examples: [
    {
      name: 'disable',
      params: { id: '3' },
      body: { enabled: false },
      response: {
        admin: {
          ...adminListItemExample,
          id: '3',
          account: 'operator',
          isSuper: false,
          enabled: false,
        },
        // Disabling an account ends its sessions immediately, not at next login.
        revokedSessions: 1,
      },
    },
  ],
});

export const systemAdminResetPassword = defineRoute({
  id: 'system.adminResetPassword',
  method: 'POST',
  path: '/admin-api/admins/:id/password',
  auth: 'admin',
  permission: 'system:admin:write',
  consoleOnly: true,
  summary: '重置管理员密码',
  tags: ['system'],
  params: adminParams,
  body: adminPasswordBody,
  response: passwordChangeResult,
  errors: ['SYSTEM_ADMIN_NOT_FOUND', 'SYSTEM_GRANT_EXCEEDS_OWN'],
  examples: [
    {
      name: 'reset',
      params: { id: '3' },
      body: { password: 'xzoo-987654' },
      response: { revokedSessions: 2 },
    },
  ],
});

export const systemAdminDelete = defineRoute({
  id: 'system.adminDelete',
  method: 'DELETE',
  path: '/admin-api/admins/:id',
  auth: 'admin',
  permission: 'system:admin:delete',
  consoleOnly: true,
  summary: '删除管理员',
  tags: ['system'],
  params: adminParams,
  response: z.void(),
  status: 204,
  errors: ['SYSTEM_ADMIN_NOT_FOUND', 'SYSTEM_ADMIN_SELF_LOCKOUT', 'SYSTEM_GRANT_EXCEEDS_OWN'],
  examples: [{ name: 'ok', params: { id: '3' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// the caller's own account
// ---------------------------------------------------------------------------

export const systemProfileGet = defineRoute({
  id: 'system.profileGet',
  method: 'GET',
  path: '/admin-api/profile',
  auth: 'admin',
  permission: 'auth:profile:read',
  summary: '我的资料',
  tags: ['system'],
  response: adminSelfProfile,
  examples: [{ name: 'ok', response: adminSelfProfileExample }],
});

export const systemProfileUpdate = defineRoute({
  id: 'system.profileUpdate',
  method: 'PUT',
  path: '/admin-api/profile',
  auth: 'admin',
  permission: 'auth:profile:update',
  summary: '修改我的资料',
  tags: ['system'],
  body: profileForm,
  response: adminSelfProfile,
  examples: [
    {
      name: 'rename',
      body: { name: '超级管理员（值班）', phone: '13800000002' },
      response: {
        ...adminSelfProfileExample,
        name: '超级管理员（值班）',
        phone: '13800000002',
      },
    },
  ],
});

export const systemProfileChangePassword = defineRoute({
  id: 'system.profileChangePassword',
  method: 'POST',
  path: '/admin-api/profile/password',
  auth: 'admin',
  permission: 'auth:profile:update',
  summary: '修改我的密码',
  tags: ['system'],
  body: profilePasswordBody,
  response: passwordChangeResult,
  errors: ['SYSTEM_PASSWORD_MISMATCH'],
  examples: [
    {
      name: 'ok',
      body: {
        currentPassword: 'xzoo123456',
        newPassword: 'xzoo-654321',
        confirmPassword: 'xzoo-654321',
      },
      // Including the caller's own: the browser is logged out on purpose.
      response: { revokedSessions: 3 },
    },
  ],
});
