import { definePermissions } from '../auth/permissions';

/**
 * 页面装修 v2.
 *
 * Three atoms, by consequence: looking, editing a draft nobody sees, and
 * anything that changes what shoppers see (publish, roll back, designate the
 * 首页 / 个人中心). A preview token is a read: it shows the draft only to
 * whoever holds the link.
 */
export const decorPermissions = definePermissions(
  'decor',
  {
    'page:read': '查看装修页面',
    'page:write': '编辑装修页面草稿',
    'page:publish': '发布装修页面',
  },
  { section: '页面装修' },
);
