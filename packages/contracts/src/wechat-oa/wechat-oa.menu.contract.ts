import { z } from 'zod';
import { id, pageQuery } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import { pagedWechatMenus, wechatMenu, wechatMenuExample, wechatMenuForm } from './schemas';

/**
 * The Official Account bottom menu, `/admin-api/wechat-menus`.
 *
 * A menu is a row, several may exist, and exactly one is active
 * (`wechat_oa_menus_active_uq`), so "what did we publish last week" has an
 * answer and "put last week's menu back" is not a manual retype.
 *
 * **Saving is not publishing.** `PUT` writes the draft; `POST …/publish` is the
 * only route that talks to `cgi-bin/menu/create`, and it is the only one that
 * can fail with `WECHAT_OA_API_FAILED`, so a WeChat outage never loses the
 * operator's edits.
 */

const menuParams = z.object({ id });

export const wechatOaMenuList = defineRoute({
  id: 'wechatOa.menuList',
  method: 'GET',
  path: '/admin-api/wechat-menus',
  auth: 'admin',
  permission: 'wechat-oa:menu:read',
  summary: '公众号菜单列表',
  tags: ['wechat-oa'],
  query: pageQuery,
  response: pagedWechatMenus,
  examples: [
    {
      name: 'one-active',
      query: { page: 1, pageSize: 20 },
      response: { items: [wechatMenuExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'refused-draft',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [
          wechatMenuExample,
          {
            ...wechatMenuExample,
            id: '2',
            name: '春节菜单',
            isActive: false,
            publishedAt: null,
            publishError: 'cgi-bin/menu/create 40055: invalid button url domain',
            publishErrorSummary:
              '一级菜单的跳转链接不是有效的网址，请检查是否以 https:// 开头（错误码 40055）',
          },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});

export const wechatOaMenuCurrent = defineRoute({
  id: 'wechatOa.menuCurrent',
  method: 'GET',
  path: '/admin-api/wechat-menus/current',
  auth: 'admin',
  permission: 'wechat-oa:menu:read',
  summary: '当前生效的菜单',
  tags: ['wechat-oa'],
  /** `null` before anything has ever been saved, which the editor renders as a blank tree. */
  response: wechatMenu.nullable(),
  examples: [
    { name: 'active', response: wechatMenuExample },
    { name: 'none-yet', response: null },
  ],
});

export const wechatOaMenuCreate = defineRoute({
  id: 'wechatOa.menuCreate',
  method: 'POST',
  path: '/admin-api/wechat-menus',
  auth: 'admin',
  permission: 'wechat-oa:menu:write',
  summary: '新建菜单',
  tags: ['wechat-oa'],
  body: wechatMenuForm,
  response: wechatMenu,
  status: 201,
  errors: ['WECHAT_OA_MENU_INVALID'],
  examples: [
    {
      name: 'two-buttons',
      body: { name: '默认菜单', buttons: wechatMenuExample.buttons },
      response: { ...wechatMenuExample, isActive: false, publishedAt: null },
    },
  ],
});

export const wechatOaMenuUpdate = defineRoute({
  id: 'wechatOa.menuUpdate',
  method: 'PUT',
  path: '/admin-api/wechat-menus/:id',
  auth: 'admin',
  permission: 'wechat-oa:menu:write',
  summary: '编辑菜单',
  tags: ['wechat-oa'],
  params: menuParams,
  body: wechatMenuForm,
  response: wechatMenu,
  errors: ['WECHAT_OA_MENU_NOT_FOUND', 'WECHAT_OA_MENU_INVALID'],
  examples: [
    {
      name: 'rename',
      params: { id: '1' },
      body: { name: '春节菜单', buttons: wechatMenuExample.buttons },
      response: { ...wechatMenuExample, name: '春节菜单' },
    },
  ],
});

export const wechatOaMenuDelete = defineRoute({
  id: 'wechatOa.menuDelete',
  method: 'DELETE',
  path: '/admin-api/wechat-menus/:id',
  auth: 'admin',
  permission: 'wechat-oa:menu:write',
  summary: '删除菜单',
  tags: ['wechat-oa'],
  params: menuParams,
  response: z.void(),
  status: 204,
  errors: ['WECHAT_OA_MENU_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '2' }, response: undefined }],
});

/**
 * Pushes the tree to WeChat and, only if WeChat accepted it, makes it active.
 *
 * The order matters. Marking it active first and pushing afterwards leaves the
 * admin screen claiming a menu is live that the phone does not show; the
 * row carries `publishErrorSummary` (and the raw `publishError`) so a failure
 * is visible on the row rather than only in a toast the operator has already
 * dismissed.
 */
export const wechatOaMenuPublish = defineRoute({
  id: 'wechatOa.menuPublish',
  method: 'POST',
  path: '/admin-api/wechat-menus/:id/publish',
  auth: 'admin',
  permission: 'wechat-oa:menu:publish',
  summary: '发布菜单到微信',
  tags: ['wechat-oa'],
  params: menuParams,
  response: wechatMenu,
  errors: [
    'WECHAT_OA_MENU_NOT_FOUND',
    'WECHAT_OA_MENU_INVALID',
    'WECHAT_OA_NOT_CONFIGURED',
    'WECHAT_OA_API_FAILED',
  ],
  examples: [{ name: 'published', params: { id: '1' }, response: wechatMenuExample }],
});
