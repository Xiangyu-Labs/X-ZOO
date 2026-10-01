import { defineMenu } from './types';

/**
 * 内容管理 → 文章 / 文章分类.
 *
 * Order 600 sits between 物流 (500) and 页面装修 (700): articles are what the
 * DIY pages link to, so the two read as one block in the sider.
 */
export default defineMenu({
  key: 'cms',
  label: '内容管理',
  icon: 'ReadOutlined',
  order: 600,
  children: [
    {
      key: 'cms.articles',
      label: '文章管理',
      path: '/admin/cms/articles',
      permission: 'cms:article:read',
      order: 10,
    },
    {
      key: 'cms.categories',
      label: '文章分类',
      path: '/admin/cms/article-categories',
      permission: 'cms:article:read',
      order: 20,
    },
  ],
});
