import { z } from 'zod';
import { defineConfigGroup, type ConfigVisibleWhen } from '../kernel/config-registry';

/** `none` means no tracking at all, so the credentials have nothing to say. */
const TRACKING_ON: ConfigVisibleWhen = { key: 'provider', equals: 'aliyun-market' };

/**
 * `logistics` — express tracking.
 *
 * Read by the shipping domain and by fulfilment.
 *
 * 电子面单 (printed waybills) went through 一号通, which is out of scope, so what
 * is left is the tracking query and the default waybill contact — the latter is
 * still worth storing because it is what a shop prints on a return label.
 *
 * **One provider, 阿里云云市场.** Only the market API has a driver. A setting
 * that looks supported and silently answers nothing is worse than no setting,
 * so there is no 快递100 option. The seeded carrier codes are 快递100's
 * all the same; the driver translates them (`shipping.aliyun-codes.ts`).
 */
export const logisticsConfig = defineConfigGroup({
  group: 'logistics',
  title: '物流设置',
  description: '物流轨迹查询服务与默认发件人。',
  category: 'integration',
  permission: 'system:config:read',
  schema: z.object({
    /** `none` disables the 物流跟踪 tab rather than showing an empty one. */
    provider: z.enum(['none', 'aliyun-market']).default('none'),
    /** Aliyun 云市场 appcode. */
    appCode: z.string().max(128).default(''),
    /** How long a tracking result may be reused. Carriers rate-limit hard. */
    cacheMinutes: z.number().int().min(1).max(1440).default(30),

    senderName: z.string().max(64).default(''),
    senderPhone: z.string().max(32).default(''),
    senderAddress: z.string().max(255).default(''),
  }),
  status: (c) =>
    c.provider === 'none'
      ? { tone: 'off', text: '未启用' }
      : c.appCode === ''
        ? { tone: 'incomplete', text: '缺 AppCode' }
        : { tone: 'on', text: '阿里云云市场' },
  ui: {
    provider: {
      label: '物流查询服务',
      type: 'select',
      options: [
        { label: '不启用', value: 'none' },
        { label: '阿里云云市场', value: 'aliyun-market' },
      ],
      order: 1,
    },
    appCode: {
      label: 'AppCode',
      type: 'password',
      help: '云市场「已购买的服务」里的 AppCode；AppKey 与 AppSecret 不用填。须购买接口地址为 wuliu.market.alicloudapi.com/kdi 的「全国快递物流查询」',
      secret: true,
      visibleWhen: TRACKING_ON,
      order: 2,
    },
    cacheMinutes: {
      label: '查询结果缓存',
      type: 'number',
      unit: 'minutes',
      visibleWhen: TRACKING_ON,
      order: 4,
    },
    senderName: { label: '发件人', type: 'text', section: '发件信息', order: 10 },
    senderPhone: { label: '发件电话', type: 'text', section: '发件信息', order: 11 },
    senderAddress: { label: '发件地址', type: 'text', section: '发件信息', order: 12 },
  },
});
