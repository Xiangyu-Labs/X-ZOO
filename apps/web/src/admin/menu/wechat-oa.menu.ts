import { defineMenu } from './types';

/**
 * 微信 → 公众号.
 *
 * The four screens an operator actually opens, in the order they are set up:
 * the bottom menu, the replies it triggers, the material those replies send,
 * and the channel codes that bring people in.
 *
 * `permission` here only decides what the sider shows; the server re-checks the
 * atom declared on each route. Both lists come from `wechatOaPermissions` in
 * `@shop/core/wechat-oa/permissions.ts` — 渠道码分类 is filed under
 * `qrcode:read` rather than a category atom of its own because a category with
 * no codes in it is not a thing anybody would be given separate access to.
 */
export default defineMenu({
  key: 'wechat-oa',
  label: '公众号',
  icon: 'WechatOutlined',
  order: 600,
  children: [
    {
      key: 'wechat-oa.menu',
      label: '自定义菜单',
      path: '/admin/wechat-oa/menu',
      permission: 'wechat-oa:menu:read',
      order: 10,
    },
    {
      key: 'wechat-oa.autoReplies',
      label: '自动回复',
      path: '/admin/wechat-oa/auto-replies',
      permission: 'wechat-oa:reply:read',
      order: 20,
    },
    {
      key: 'wechat-oa.media',
      label: '微信素材',
      path: '/admin/wechat-oa/media',
      permission: 'wechat-oa:media:read',
      order: 30,
    },
    {
      key: 'wechat-oa.qrcodes',
      label: '渠道二维码',
      path: '/admin/wechat-oa/qrcodes',
      permission: 'wechat-oa:qrcode:read',
      order: 40,
    },
    {
      key: 'wechat-oa.qrcodeCategories',
      label: '渠道码分类',
      path: '/admin/wechat-oa/qrcode-categories',
      permission: 'wechat-oa:qrcode:read',
      order: 50,
    },
  ],
});
