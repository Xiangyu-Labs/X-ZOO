import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedUserGroups,
  pagedUserLabelCategories,
  pagedUserLabels,
  userGroup,
  userGroupExample,
  userGroupForm,
  userGroupListQuery,
  userLabel,
  userLabelCategory,
  userLabelCategoryExample,
  userLabelCategoryForm,
  userLabelCategoryListQuery,
  userLabelExample,
  userLabelForm,
  userLabelListQuery,
} from './schemas';

/**
 * 用户分组 and 用户标签, `/admin-api/user-groups`, `/admin-api/user-labels`,
 * `/admin-api/user-label-categories`.
 *
 * Groups are a many-to-many join (`user_groups_map`), not a single column on
 * the user, so "this customer is both 高价值 and 待激活" can be said.
 *
 * All three are small, operator-managed reference lists, so they are plain CRUD
 * and share `user:group:*` / `user:label:*`. A label category is not a separate
 * job from a label — the same person maintains both on the same screen — so it
 * reuses the label atoms rather than inventing a third pair nobody grants.
 */

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export const userGroupList = defineRoute({
  id: 'user.groupList',
  method: 'GET',
  path: '/admin-api/user-groups',
  auth: 'admin',
  permission: 'user:group:read',
  summary: '用户分组列表',
  tags: ['user'],
  query: userGroupListQuery,
  response: pagedUserGroups,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: { items: [userGroupExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const userGroupCreate = defineRoute({
  id: 'user.groupCreate',
  method: 'POST',
  path: '/admin-api/user-groups',
  auth: 'admin',
  permission: 'user:group:write',
  summary: '新增用户分组',
  tags: ['user'],
  body: userGroupForm,
  response: userGroup,
  status: 201,
  errors: ['USER_GROUP_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      body: { name: '高价值客户', sortOrder: 10 },
      response: { ...userGroupExample, memberCount: 0 },
    },
  ],
});

export const userGroupUpdate = defineRoute({
  id: 'user.groupUpdate',
  method: 'PUT',
  path: '/admin-api/user-groups/:id',
  auth: 'admin',
  permission: 'user:group:write',
  summary: '编辑用户分组',
  tags: ['user'],
  params: z.object({ id }),
  body: userGroupForm,
  response: userGroup,
  errors: ['USER_GROUP_NOT_FOUND', 'USER_GROUP_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      params: { id: '3' },
      body: { name: '高价值客户', sortOrder: 20 },
      response: { ...userGroupExample, sortOrder: 20 },
    },
  ],
});

/** Deleting a group drops its memberships; the customers themselves are untouched. */
export const userGroupDelete = defineRoute({
  id: 'user.groupDelete',
  method: 'DELETE',
  path: '/admin-api/user-groups/:id',
  auth: 'admin',
  permission: 'user:group:write',
  summary: '删除用户分组',
  tags: ['user'],
  params: z.object({ id }),
  response: z.void(),
  status: 204,
  errors: ['USER_GROUP_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '3' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// label categories
// ---------------------------------------------------------------------------

export const userLabelCategoryList = defineRoute({
  id: 'user.labelCategoryList',
  method: 'GET',
  path: '/admin-api/user-label-categories',
  auth: 'admin',
  permission: 'user:label:read',
  summary: '标签分类列表',
  tags: ['user'],
  query: userLabelCategoryListQuery,
  response: pagedUserLabelCategories,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: { items: [userLabelCategoryExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const userLabelCategoryCreate = defineRoute({
  id: 'user.labelCategoryCreate',
  method: 'POST',
  path: '/admin-api/user-label-categories',
  auth: 'admin',
  permission: 'user:label:write',
  summary: '新增标签分类',
  tags: ['user'],
  body: userLabelCategoryForm,
  response: userLabelCategory,
  status: 201,
  errors: ['USER_LABEL_CATEGORY_NAME_TAKEN'],
  examples: [
    { name: 'ok', body: { name: '消费偏好', sortOrder: 0 }, response: userLabelCategoryExample },
  ],
});

export const userLabelCategoryUpdate = defineRoute({
  id: 'user.labelCategoryUpdate',
  method: 'PUT',
  path: '/admin-api/user-label-categories/:id',
  auth: 'admin',
  permission: 'user:label:write',
  summary: '编辑标签分类',
  tags: ['user'],
  params: z.object({ id }),
  body: userLabelCategoryForm,
  response: userLabelCategory,
  errors: ['USER_LABEL_CATEGORY_NOT_FOUND', 'USER_LABEL_CATEGORY_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      params: { id: '2' },
      body: { name: '消费偏好', sortOrder: 5 },
      response: { ...userLabelCategoryExample, sortOrder: 5 },
    },
  ],
});

/** Labels in a deleted category keep working; their `categoryId` becomes `null`. */
export const userLabelCategoryDelete = defineRoute({
  id: 'user.labelCategoryDelete',
  method: 'DELETE',
  path: '/admin-api/user-label-categories/:id',
  auth: 'admin',
  permission: 'user:label:write',
  summary: '删除标签分类',
  tags: ['user'],
  params: z.object({ id }),
  response: z.void(),
  status: 204,
  errors: ['USER_LABEL_CATEGORY_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '2' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

export const userLabelList = defineRoute({
  id: 'user.labelList',
  method: 'GET',
  path: '/admin-api/user-labels',
  auth: 'admin',
  permission: 'user:label:read',
  summary: '用户标签列表',
  tags: ['user'],
  query: userLabelListQuery,
  response: pagedUserLabels,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: { items: [userLabelExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'by-category',
      query: { page: 1, pageSize: 20, categoryId: '2' },
      response: { items: [userLabelExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const userLabelCreate = defineRoute({
  id: 'user.labelCreate',
  method: 'POST',
  path: '/admin-api/user-labels',
  auth: 'admin',
  permission: 'user:label:write',
  summary: '新增用户标签',
  tags: ['user'],
  body: userLabelForm,
  response: userLabel,
  status: 201,
  errors: ['USER_LABEL_NAME_TAKEN', 'USER_LABEL_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      body: { categoryId: '2', name: '母婴', sortOrder: 0 },
      response: { ...userLabelExample, memberCount: 0 },
    },
  ],
});

export const userLabelUpdate = defineRoute({
  id: 'user.labelUpdate',
  method: 'PUT',
  path: '/admin-api/user-labels/:id',
  auth: 'admin',
  permission: 'user:label:write',
  summary: '编辑用户标签',
  tags: ['user'],
  params: z.object({ id }),
  body: userLabelForm,
  response: userLabel,
  errors: ['USER_LABEL_NOT_FOUND', 'USER_LABEL_NAME_TAKEN', 'USER_LABEL_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'ok',
      params: { id: '7' },
      body: { categoryId: '2', name: '母婴用品', sortOrder: 1 },
      response: { ...userLabelExample, name: '母婴用品', sortOrder: 1 },
    },
  ],
});

export const userLabelDelete = defineRoute({
  id: 'user.labelDelete',
  method: 'DELETE',
  path: '/admin-api/user-labels/:id',
  auth: 'admin',
  permission: 'user:label:write',
  summary: '删除用户标签',
  tags: ['user'],
  params: z.object({ id }),
  response: z.void(),
  status: 204,
  errors: ['USER_LABEL_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7' }, response: undefined }],
});
