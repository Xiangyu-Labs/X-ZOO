import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `content-security` — WeChat's 内容安全 for what shoppers write and upload (C09).
 *
 * One switch. On by default, because a mini program that publishes shopper
 * content unchecked is a review rejection waiting to happen; it only ever acts
 * for an account that signed in through the mini program (WeChat checks
 * content *for an openid*), so an H5-only shop loses nothing by leaving it on.
 * What each verdict does per kind of content is fixed in
 * `wechat.sec-check.ts`, not configurable: it is policy, not preference.
 */
export const contentSecurityConfig = defineConfigGroup({
  group: 'content-security',
  title: '内容安全',
  description: '用户提交的文字与图片是否先经过微信内容安全检测。',
  category: 'wechat',
  permission: 'payment:config:write',
  schema: z.object({
    enabled: z.boolean().default(true),
  }),
  status: (c) => (c.enabled ? { tone: 'on', text: '检测中' } : { tone: 'off', text: '未开启' }),
  ui: {
    enabled: {
      label: '启用微信内容安全检测',
      type: 'switch',
      help: '小程序用户提交的评价、昵称、发票抬头和上传的评价图片、头像，交给微信内容安全接口检测。疑似违规的评价进入「待审核」，不会直接拒绝',
      order: 1,
    },
  },
});

export type ContentSecurityConfig = z.infer<typeof contentSecurityConfig.schema>;
