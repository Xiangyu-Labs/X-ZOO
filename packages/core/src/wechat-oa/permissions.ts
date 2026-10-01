import { definePermissions } from '../auth/permissions';

/**
 * Official Account permission atoms.
 *
 * `menu:publish` is separate from `menu:write` on purpose: editing a draft
 * changes a row, publishing changes what every follower of the account sees
 * within minutes and cannot be undone by editing the draft back. They are
 * different jobs and, in a shop with an agency running the account, different
 * people.
 *
 * The storefront routes (`jssdk-config`, `subscribe-templates`) hold no atom —
 * they are `auth: 'user-optional'` and answer about the shop's own public
 * configuration.
 */
export const wechatOaPermissions = definePermissions(
  'wechat-oa',
  {
    'menu:read': '查看公众号菜单',
    'menu:write': '编辑公众号菜单',
    'menu:publish': '发布公众号菜单',
    'reply:read': '查看自动回复',
    'reply:write': '编辑自动回复',
    'media:read': '查看微信素材',
    'media:write': '上传/删除微信素材',
    'qrcode:read': '查看渠道二维码',
    'qrcode:write': '管理渠道二维码',
  },
  { section: '微信' },
);
