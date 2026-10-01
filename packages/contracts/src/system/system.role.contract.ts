import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedRoles,
  permissionTree,
  roleDetail,
  roleDetailExample,
  roleForm,
  roleListItemExample,
  roleListQuery,
  roleStatusBody,
} from './schemas';

/**
 * Roles (管理员身份) and the permission tree the editor renders.
 *
 * The tree is built from the atoms `definePermissions` registered in code, so
 * it is always exactly what the server will check: there is no menu table in
 * which a permission could exist in the tree and nowhere else.
 */

const roleParams = z.object({ id });

export const systemRoleList = defineRoute({
  id: 'system.roleList',
  method: 'GET',
  path: '/admin-api/roles',
  auth: 'admin',
  permission: 'system:role:read',
  summary: '身份列表',
  tags: ['system'],
  query: roleListQuery,
  response: pagedRoles,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [roleListItemExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const systemRoleDetail = defineRoute({
  id: 'system.roleDetail',
  method: 'GET',
  path: '/admin-api/roles/:id',
  auth: 'admin',
  permission: 'system:role:read',
  summary: '身份详情',
  tags: ['system'],
  params: roleParams,
  response: roleDetail,
  errors: ['SYSTEM_ROLE_NOT_FOUND'],
  examples: [
    { name: 'ok', params: { id: '2' }, response: roleDetailExample },
    {
      name: 'with-retired-atom',
      params: { id: '3' },
      response: {
        ...roleDetailExample,
        id: '3',
        name: '客服',
        remark: null,
        permissionCount: 2,
        permissions: ['order:order:read', 'seckill:campaign:read'],
        // Retired with the seckill module; stored, granted nothing, shown so it can be cleared.
        unknownPermissions: ['seckill:campaign:read'],
      },
    },
  ],
});

export const systemRoleCreate = defineRoute({
  id: 'system.roleCreate',
  method: 'POST',
  path: '/admin-api/roles',
  auth: 'admin',
  permission: 'system:role:write',
  consoleOnly: true,
  summary: '新建身份',
  tags: ['system'],
  body: roleForm,
  response: roleDetail,
  status: 201,
  errors: ['SYSTEM_ROLE_NAME_TAKEN', 'SYSTEM_PERMISSION_UNKNOWN', 'SYSTEM_GRANT_EXCEEDS_OWN'],
  examples: [
    {
      name: 'operator',
      body: {
        name: '运营',
        remark: '商品与营销',
        enabled: true,
        permissions: ['coupon:template:read', 'coupon:template:write'],
      },
      response: { ...roleDetailExample, adminCount: 0, permissionCount: 2 },
    },
  ],
});

export const systemRoleUpdate = defineRoute({
  id: 'system.roleUpdate',
  method: 'PUT',
  path: '/admin-api/roles/:id',
  auth: 'admin',
  permission: 'system:role:write',
  consoleOnly: true,
  summary: '编辑身份',
  tags: ['system'],
  params: roleParams,
  body: roleForm,
  response: roleDetail,
  errors: [
    'SYSTEM_ROLE_NOT_FOUND',
    'SYSTEM_ROLE_NAME_TAKEN',
    'SYSTEM_PERMISSION_UNKNOWN',
    'SYSTEM_GRANT_EXCEEDS_OWN',
  ],
  examples: [
    {
      name: 'grant-one-more',
      params: { id: '2' },
      body: {
        name: '运营',
        remark: '商品与营销',
        enabled: true,
        permissions: ['coupon:template:read', 'coupon:template:write', 'coupon:grant:write'],
      },
      response: {
        ...roleDetailExample,
        permissionCount: 3,
        permissions: ['coupon:grant:write', 'coupon:template:read', 'coupon:template:write'],
      },
    },
  ],
});

export const systemRoleSetStatus = defineRoute({
  id: 'system.roleSetStatus',
  method: 'POST',
  path: '/admin-api/roles/:id/status',
  auth: 'admin',
  permission: 'system:role:write',
  consoleOnly: true,
  summary: '启用/停用身份',
  tags: ['system'],
  params: roleParams,
  body: roleStatusBody,
  response: roleDetail,
  errors: ['SYSTEM_ROLE_NOT_FOUND', 'SYSTEM_GRANT_EXCEEDS_OWN'],
  examples: [
    {
      name: 'disable',
      params: { id: '2' },
      body: { enabled: false },
      // A disabled role grants nothing: `loadPermissions` joins on `roles.status = 1`.
      response: { ...roleDetailExample, enabled: false },
    },
  ],
});

export const systemRoleDelete = defineRoute({
  id: 'system.roleDelete',
  method: 'DELETE',
  path: '/admin-api/roles/:id',
  auth: 'admin',
  permission: 'system:role:delete',
  consoleOnly: true,
  summary: '删除身份',
  tags: ['system'],
  params: roleParams,
  response: z.void(),
  status: 204,
  errors: ['SYSTEM_ROLE_NOT_FOUND', 'SYSTEM_ROLE_IN_USE', 'SYSTEM_GRANT_EXCEEDS_OWN'],
  examples: [{ name: 'ok', params: { id: '4' }, response: undefined }],
});

export const systemPermissionTree = defineRoute({
  id: 'system.permissionTree',
  method: 'GET',
  path: '/admin-api/permissions',
  auth: 'admin',
  permission: 'system:role:read',
  summary: '权限原子树',
  tags: ['system'],
  response: permissionTree,
  examples: [
    {
      name: 'ok',
      response: {
        sections: [
          {
            section: '账号',
            items: [
              { atom: 'auth:profile:read', label: '查看自己的资料', domain: 'auth', requires: [] },
              {
                atom: 'auth:profile:update',
                label: '修改自己的资料与密码',
                domain: 'auth',
                requires: [],
              },
              { atom: 'auth:session:delete', label: '退出登录', domain: 'auth', requires: [] },
              {
                atom: 'auth:session:read',
                label: '读取自己的登录信息',
                domain: 'auth',
                requires: [],
              },
            ],
          },
          {
            section: '营销',
            items: [
              { atom: 'coupon:template:read', label: '查看优惠券', domain: 'coupon', requires: [] },
              {
                atom: 'coupon:template:write',
                label: '新建/编辑优惠券',
                domain: 'coupon',
                requires: [],
              },
            ],
          },
        ],
        implicit: [
          'auth:profile:read',
          'auth:profile:update',
          'auth:session:delete',
          'auth:session:read',
        ],
      },
    },
  ],
});
