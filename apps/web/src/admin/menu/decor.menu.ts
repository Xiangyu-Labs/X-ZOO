import { defineMenu } from './types';

/**
 * 店铺装修: the page documents the mini-program renders.
 *
 * The editor is `hidden`: it is reached from the list and only needs to give
 * the breadcrumb a parent.
 */
export default defineMenu({
  key: 'decor',
  label: '店铺装修',
  icon: 'LayoutOutlined',
  order: 690,
  permission: 'decor:page:read',
  children: [
    {
      key: 'decor.documents',
      label: '页面列表',
      path: '/admin/decor',
      permission: 'decor:page:read',
      order: 10,
    },
    {
      key: 'decor.document',
      label: '装修页面',
      path: '/admin/decor/:id',
      permission: 'decor:page:read',
      order: 20,
      hidden: true,
    },
  ],
});
