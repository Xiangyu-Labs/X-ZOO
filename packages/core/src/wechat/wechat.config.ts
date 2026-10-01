import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * The `wechat` config group: the Official Account and mini-program app
 * credentials.
 *
 * It lives with the domain that reads it rather than under `system/config/`: a
 * shared folder every domain writes into would tie them all to `system`.
 * Registration is a side effect of importing this module, which
 * `wechat/index.ts` does.
 *
 * Every field has a `.default()`: a fresh install must be able to read the
 * group before anybody has saved it, or the shop cannot boot.
 *
 * Secrets carry `secret: true`, which means the admin form receives an "is set"
 * boolean and plaintext travels back only when an operator retypes it. Nothing
 * in this file is ever logged: `wechat.client.ts` redacts by never putting a
 * credential into a log object in the first place.
 */

/**
 * A stored text setting.
 *
 * `config_values.value` is `jsonb`, and a string written to it must come back a
 * string even when it is all digits — a 商户号, a phone number. Parsing the
 * value twice on the way out would turn it into a *number*; `@shop/db` has json
 * and jsonb reach drizzle as text and parses them once, so this is a plain
 * string. The round trip is covered by a test in every group this domain owns,
 * because the failure mode is silent: the field falls back to its default and
 * the shop reports 支付尚未配置 with a filled-in form.
 */
const configText = (max: number) => z.string().max(max).default('');

export const wechatConfig = defineConfigGroup({
  group: 'wechat',
  title: '微信公众号 / 小程序',
  description: '公众号与小程序的 AppID、AppSecret 与消息加解密。',
  category: 'wechat',
  permission: 'payment:config:write',
  schema: z.object({
    oaAppId: configText(64),
    oaAppSecret: configText(128),
    /**
     * The token the OA message callback signs with, and the 43-character AES
     * key for its message encryption (optional: plaintext mode works).
     *
     * These two are the one WeChat credential pair this group is **not** the
     * home of. The `system` domain's `wechat-oa` group declares the same
     * settings, and it is the screen 公众号消息配置 lives on; with two equal
     * homes the operator would edit one screen and the other would keep a stale
     * copy. The fields stay declared here so an install that only ever filled
     * in this screen keeps working: `oaCredentials()` reads the `wechat-oa`
     * group first and falls back to these.
     */
    oaToken: configText(64),
    oaAesKey: configText(64),
    miniAppId: configText(64),
    miniAppSecret: configText(128),
    /**
     * The token and AES key of the mini program's 消息推送, and the mode it is
     * configured in (公众平台 → 开发管理 → 消息推送, 数据格式 JSON).
     *
     * `wechat.mini-push.ts` verifies `/api/v1/webhooks/wechat-mini` with them:
     * 发货信息管理's `trade_manage_*` events (C07) and 内容安全's
     * `wxa_media_check` verdicts (C09) arrive there. 自建客服 is still out of
     * scope; customer-service messages to the same URL are acknowledged and
     * dropped.
     */
    miniToken: configText(64),
    miniAesKey: configText(64),
    miniMessageMode: z.enum(['plain', 'compatible', 'safe']).default('plain'),
    /**
     * `api.weixin.qq.com`, overridable so integration tests can point the whole
     * client at a local fake. Never settable from the admin UI: it has no `ui`
     * entry, so `ConfigGroupForm` does not render it.
     */
    apiBaseUrl: z.string().max(255).default('https://api.weixin.qq.com'),
  }),
  status: (c) => {
    const apps = [
      { name: '公众号', id: c.oaAppId, secret: c.oaAppSecret },
      { name: '小程序', id: c.miniAppId, secret: c.miniAppSecret },
    ];
    const half = apps.find((app) => (app.id === '') !== (app.secret === ''));
    if (half) return { tone: 'incomplete', text: `${half.name} AppID 与 AppSecret 缺一` };
    const done = apps.filter((app) => app.id !== '').map((app) => app.name);
    return done.length === 0
      ? { tone: 'off', text: '未配置' }
      : { tone: 'on', text: done.join('、') };
  },
  ui: {
    oaAppId: { label: '公众号 AppID', type: 'text', section: '公众号', order: 10 },
    oaAppSecret: {
      label: '公众号 AppSecret',
      type: 'password',
      secret: true,
      section: '公众号',
      order: 20,
    },
    oaToken: {
      label: '消息校验 Token',
      type: 'password',
      secret: true,
      section: '公众号',
      order: 30,
    },
    oaAesKey: {
      label: '消息加解密密钥',
      type: 'password',
      secret: true,
      help: '留空表示使用明文模式',
      section: '公众号',
      order: 40,
    },
    miniAppId: { label: '小程序 AppID', type: 'text', section: '小程序', order: 10 },
    miniAppSecret: {
      label: '小程序 AppSecret',
      type: 'password',
      secret: true,
      section: '小程序',
      order: 20,
    },
    miniToken: {
      label: '小程序消息 Token',
      type: 'password',
      secret: true,
      help: '公众平台「开发管理 → 消息推送」中的 Token；推送地址为 /api/v1/webhooks/wechat-mini，数据格式选 JSON',
      section: '小程序',
      order: 30,
    },
    miniMessageMode: {
      label: '小程序消息加解密方式',
      type: 'select',
      options: [
        { label: '明文模式', value: 'plain' },
        { label: '兼容模式', value: 'compatible' },
        { label: '安全模式', value: 'safe' },
      ],
      section: '小程序',
      order: 40,
    },
    miniAesKey: {
      label: '小程序 EncodingAESKey',
      type: 'password',
      secret: true,
      visibleWhen: { key: 'miniMessageMode', equals: ['compatible', 'safe'] },
      section: '小程序',
      order: 50,
    },
  },
});

export type WechatConfig = z.infer<typeof wechatConfig.schema>;
