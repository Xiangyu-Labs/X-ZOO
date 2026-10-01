import { definePermissions } from '../auth/permissions';

/**
 * CMS permission atoms.
 *
 * Four, and the split follows who gets hurt by a mistake:
 *
 *  - `article:read` / `article:write` is the day-to-day job — writing 公告 and
 *    活动说明. Publishing is part of writing: an article an operator may edit
 *    but not publish has no workflow behind it here, and inventing an approval
 *    step nobody asked for would be a redesign.
 *  - `article:delete` is separate because an article carries its view counter
 *    and its share links; deleting one breaks URLs that were sent to customers.
 *  - `category:write` is separate because the categories are the storefront's
 *    navigation: renaming one is cosmetic, hiding one empties a tab.
 *
 * There is no `category:read` atom — the category list is what the article
 * filter and the article form are built out of, so it rides on
 * `article:read`, the same way the city tree rides on `shipping:template:read`.
 */
export const cmsPermissions = definePermissions(
  'cms',
  {
    'article:read': '查看文章',
    'article:write': '新建/编辑文章',
    'article:delete': '删除文章',
    'category:write': '维护文章分类',
  },
  { section: '内容' },
);
