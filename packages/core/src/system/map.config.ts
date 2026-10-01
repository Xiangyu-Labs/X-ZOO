import { z } from 'zod';
import { defineConfigGroup, type ConfigVisibleWhen } from '../kernel/config-registry';

/** Nothing below the provider switch means anything while it is `none`. */
const MAP_ON: ConfigVisibleWhen = { key: 'provider', equals: ['tencent', 'amap'] };

/**
 * `map` — the map provider used for address picking and 门店 coordinates.

 *
 * The web key is **not** a secret: it ships to the browser by design, and
 * marking it one would only mean an operator could never check what they typed.
 * The server key is a secret, and is the one used for geocoding from the backend.
 */
export const mapConfig = defineConfigGroup({
  group: 'map',
  title: '地图设置',
  description: '地图服务商与前端、服务端 Key。',
  category: 'integration',
  permission: 'system:config:read',
  schema: z.object({
    provider: z.enum(['none', 'tencent', 'amap']).default('none'),
    /** Sent to the browser. Restrict it by referrer in the provider console. */
    webKey: z.string().max(128).default(''),
    /** Server-side geocoding key. Never leaves the server. */
    serverKey: z.string().max(128).default(''),
    defaultCity: z.string().max(32).default(''),
  }),
  status: (c) =>
    c.provider === 'none'
      ? { tone: 'off', text: '未启用' }
      : c.serverKey === ''
        ? { tone: 'incomplete', text: '缺服务端 Key' }
        : { tone: 'on', text: c.provider === 'tencent' ? '腾讯地图' : '高德地图' },
  ui: {
    provider: {
      label: '地图服务商',
      type: 'select',
      options: [
        { label: '不启用', value: 'none' },
        { label: '腾讯地图', value: 'tencent' },
        { label: '高德地图', value: 'amap' },
      ],
      order: 1,
    },
    webKey: {
      label: '前端 Key',
      type: 'text',
      help: '会下发到浏览器，请在服务商控制台按域名限制',
      visibleWhen: MAP_ON,
      order: 2,
    },
    serverKey: {
      label: '服务端 Key',
      type: 'password',
      secret: true,
      visibleWhen: MAP_ON,
      order: 3,
    },
    defaultCity: { label: '默认城市', type: 'text', visibleWhen: MAP_ON, order: 4 },
  },
});
