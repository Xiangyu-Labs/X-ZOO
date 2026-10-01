import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `wechat-oa` — 公众号 message-callback settings.
 *
 * Consumed by the `wechat-oa` domain; `system` only owns the screen.
 *
 * **The app credentials are not here.** A credential declared in two groups
 * shows in one screen and as a blank in the other, and whichever screen is
 * saved last wins. The `wechat` group owns the credentials (`getWechatClient`
 * reads them), and this group keeps only what an operator types into 公众平台
 * for the message callback.
 *
 * `token` and `encodingAesKey` are **secrets**: the descriptor endpoint sends a
 * boolean "is set" flag, the save endpoint ignores the flag coming back, and it
 * is never logged.
 */
export const wechatOaConfig = defineConfigGroup({
  group: 'wechat-oa',
  title: '微信公众号',
  description: '公众号开关、服务器配置 Token 与 EncodingAESKey。',
  category: 'wechat',
  permission: 'system:config:read',
  schema: z.object({
    enabled: z.boolean().default(false),
    /** Token the WeChat server echoes back when verifying the callback URL. */
    token: z.string().max(64).default(''),
    encodingAesKey: z.string().max(64).default(''),
    /** 明文 / 兼容 / 安全, spelled as words rather than 0/1/2. */
    messageMode: z.enum(['plain', 'compatible', 'safe']).default('plain'),
    /** Verification file WeChat asks to be served at the site root. */
    verificationFile: z.string().max(128).default(''),
  }),
  // No Token check: an install that filled in only the older 「微信公众号 /
  // 小程序」 screen keeps its Token there, and `oaCredentials` falls back to it.
  status: (c) => (c.enabled ? { tone: 'on', text: '已启用' } : { tone: 'off', text: '未启用' }),
  ui: {
    enabled: {
      label: '启用公众号',
      type: 'switch',
      help: 'AppID / AppSecret 在「微信公众号 / 小程序」里填写',
      order: 1,
    },
    // Secret: in 明文模式 this token is the whole of the callback's
    // authentication, so a settings *reader* who can see it can forge any
    // follow, scan or message. The form shows "已设置" and a blank save keeps
    // the stored value, as for `encodingAesKey`.
    token: { label: '验证 Token', type: 'password', secret: true, order: 4 },
    messageMode: {
      label: '消息加解密方式',
      type: 'select',
      options: [
        { label: '明文模式', value: 'plain' },
        { label: '兼容模式', value: 'compatible' },
        { label: '安全模式', value: 'safe' },
      ],
      order: 5,
    },
    encodingAesKey: {
      label: 'EncodingAESKey',
      type: 'password',
      secret: true,
      help: '仅安全模式/兼容模式需要',
      visibleWhen: { key: 'messageMode', equals: ['compatible', 'safe'] },
      order: 6,
    },
    verificationFile: { label: '域名校验文件名', type: 'text', order: 7 },
  },
});
