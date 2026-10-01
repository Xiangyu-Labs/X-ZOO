import { z } from 'zod';
import { webviewDomain } from '@shop/contracts/system/app.schemas';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * The 业务域名 list as typed: one per line (commas and spaces also split),
 * trimmed, lower-cased, deduplicated, first occurrence kept.
 */
export function webviewDomainsOf(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,，;；]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== ''),
    ),
  ];
}

/** Codes are minted for the version a scan opens (`getwxacodeunlimit`'s `env_version`). */
export const miniCodeEnvVersion = z.enum(['release', 'trial', 'develop']);
export type MiniCodeEnvVersion = z.infer<typeof miniCodeEnvVersion>;

/**
 * `wechat-mini` — how the 小程序 behaves, **not** what it signs in with.
 *
 * Every WeChat credential lives in the `wechat` group and nowhere else. A
 * credential claimed by two groups shows on one settings screen and as a blank
 * on the other, and whichever is saved last wins. So the AppID, the AppSecret,
 * the callback token, the AES key and the message mode are all `wechat`'s
 * (`miniAppId`, `miniAppSecret`, `miniToken`, `miniAesKey`, `miniMessageMode`),
 * and this group keeps the two things that are about the shop rather than the
 * app: is the mini program switched on, and how does 联系客服 behave.
 *
 * Readers: the mini-program sign-in checks `enabled` here and reads the app id
 * from `wechat`; the storefront reads `contactType` / `contactPhone`;
 * `GET /api/v1/app/config` reads `webviewDomains` (C12); the 小程序码 service
 * reads `codeEnvVersion` (C11).
 */
export const wechatMiniConfig = defineConfigGroup({
  group: 'wechat-mini',
  title: '微信小程序',
  description: '小程序开关、名称、客服方式与小程序码版本。',
  category: 'wechat',
  permission: 'system:config:read',
  schema: z.object({
    enabled: z.boolean().default(false),
    name: z.string().max(64).default(''),
    /**
     * How 联系客服 behaves: the mini-program's own chat window, or a phone
     * number. There is no self-hosted 自建客服 (out of scope), so there is no
     * third option.
     */
    contactType: z.enum(['mini-program', 'phone']).default('mini-program'),
    contactPhone: z.string().max(32).default(''),
    /**
     * 业务域名 (C12), as configured on 公众平台 → 开发管理 → 开发设置. A host that
     * is not a bare host name (a scheme, a path, a port) is refused on save
     * rather than "fixed up": the list must match WeChat's character for
     * character, and a guess that does not is a web-view that silently fails.
     */
    webviewDomains: z
      .string()
      .max(2000)
      .default('')
      .refine((raw) => webviewDomainsOf(raw).every((d) => webviewDomain.safeParse(d).success), {
        message: '每行一个主机名，例如 shop.example.com（不带 https:// 和路径）',
      }),
    /**
     * Which version a 小程序码 opens. `release` for the live shop; a staging
     * install previewing unreleased pages on 体验版 sets `trial`. Codes are
     * cached per version, so switching never serves a code minted for the
     * other one.
     */
    codeEnvVersion: miniCodeEnvVersion.default('release'),
  }),
  status: (c) => (c.enabled ? { tone: 'on', text: '已启用' } : { tone: 'off', text: '未启用' }),
  ui: {
    enabled: {
      label: '启用小程序',
      type: 'switch',
      help: 'AppID 与 AppSecret 在「微信公众号 / 小程序」设置中填写',
      order: 1,
    },
    name: { label: '小程序名称', type: 'text', order: 2 },
    contactType: {
      label: '联系客服方式',
      type: 'select',
      options: [
        { label: '小程序客服', value: 'mini-program' },
        { label: '拨打电话', value: 'phone' },
      ],
      order: 8,
    },
    contactPhone: {
      label: '客服电话',
      type: 'text',
      help: '「拨打电话」时使用',
      visibleWhen: { key: 'contactType', equals: 'phone' },
      order: 9,
    },
    webviewDomains: {
      label: '业务域名',
      type: 'textarea',
      help: '每行一个，须与公众平台「开发管理 → 开发设置 → 业务域名」一致；公众号文章（mp.weixin.qq.com）无需填写',
      placeholder: 'shop.example.com',
      order: 10,
    },
    codeEnvVersion: {
      label: '小程序码打开的版本',
      type: 'select',
      options: [
        { label: '正式版', value: 'release' },
        { label: '体验版', value: 'trial' },
        { label: '开发版', value: 'develop' },
      ],
      help: '线上商城请保持「正式版」',
      order: 11,
    },
  },
});
