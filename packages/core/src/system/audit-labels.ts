import { allRoutes } from '@shop/contracts/routes';
import { DESIGNATIONS, type Designation } from '@shop/contracts/decor/constants';

import { getConfigGroup } from '../kernel/config-registry';
import { findNotificationEvent } from '../notification/index';

/**
 * The 操作日志 in words a member of staff reads.
 *
 * A row stores the route id (`catalog.adminProductUpdate`) and the target a
 * handler named (`product:12`, `config:site`); both are for code. The viewer
 * shows the route's own `summary` (修改商品) and the target as 商品 #12. A route
 * removed since the row was written reads 已下线的功能; a target prefix with no
 * entry below fails `audit-labels.test.ts`, which reads every `ctx.audit(…)` in
 * the tree.
 */

let summaries: Map<string, string> | null = null;

/** The operation's name: its route's `summary`, or 已下线的功能. */
export function operationName(routeId: string): string {
  summaries ??= new Map(allRoutes.map((route) => [route.id, route.summary]));
  return summaries.get(routeId) ?? '已下线的功能';
}

/** The route ids whose name holds `keyword`, so the viewer's 关键词 finds 修改商品 too. */
export function routeIdsNamed(keyword: string): string[] {
  const needle = keyword.trim();
  if (needle === '') return [];
  return allRoutes.filter((route) => route.summary.includes(needle)).map((route) => route.id);
}

/** What each `ctx.audit('<prefix>:…')` names. */
export const AUDIT_TARGET_NOUNS: Readonly<Record<string, string>> = {
  admin: '管理员',
  'api-token': 'API 令牌',
  attachment: '素材',
  'attachment-category': '素材分组',
  category: '商品分类',
  cms: '文章',
  config: '系统设置',
  'config-test': '系统设置',
  coupon: '优惠券',
  decor: '页面装修',
  effect: '后台任务',
  'express-company': '快递公司',
  'failed-job': '失败任务',
  'groupbuy-activity': '拼团活动',
  'groupbuy-group': '拼团',
  label: '商品标签',
  'label-category': '标签分组',
  'notification-log': '通知记录',
  'notification-template': '通知模板',
  order: '订单',
  'order-export': '订单导出',
  'order-invoice': '发票',
  orders: '订单',
  'param-template': '参数模板',
  'payment-exception': '支付异常',
  presale: '预售活动',
  product: '商品',
  'product-export': '商品导出',
  protection: '保障服务',
  refund: '售后',
  review: '评价',
  reviews: '评价',
  role: '身份',
  'scan-token': '扫码上传',
  shipment: '发货单',
  'shipping-template': '运费模板',
  'stats-product-export': '商品排行导出',
  'stats-sales-export': '销售统计导出',
  'stats-trade-export': '交易统计导出',
  user: '用户',
  'user-cancellation': '注销申请',
  'user-coupon': '用户优惠券',
  'user-group': '用户分组',
  'user-groups': '用户分组',
  'user-label': '用户标签',
  'user-label-category': '用户标签分组',
  'user-labels': '用户标签',
  'wechat-auto-reply': '公众号自动回复',
  'wechat-media': '公众号素材',
  'wechat-medium': '公众号素材',
  'wechat-menu': '公众号菜单',
  'wechat-mini-trade': '小程序发货信息',
  'wechat-qrcode': '公众号二维码',
  'wechat-qrcode-category': '二维码分组',
};

const CHANNELS: Readonly<Record<string, string>> = {
  inApp: '站内信',
  wechatOa: '公众号消息',
  wechatMini: '小程序订阅消息',
  sms: '短信',
};

const ids = (list: string): string =>
  list
    .split(',')
    .map((id) => `#${id}`)
    .join('、');

/**
 * `product:12` → 商品 #12. A row with no target (a write refused before its
 * handler named one) falls back to the ids in its path, `/coupons/987654` →
 * #987654: the operation's name already says what kind of thing it is.
 */
export function targetText(target: string | null, path = ''): string | null {
  if (target === null) {
    const inPath = path.split('/').filter((segment) => /^\d+$/.test(segment));
    return inPath.length === 0 ? null : ids(inPath.join(','));
  }
  const [prefix = '', ...rest] = target.split(':');
  const noun = AUDIT_TARGET_NOUNS[prefix];
  if (noun === undefined) return target;
  const tail = rest.join(':');

  if (prefix.endsWith('export')) return `${noun}（${tail} 条）`;
  if (prefix === 'reviews') return `${tail} 条${noun}`;
  if (prefix === 'user-groups' || prefix === 'user-labels')
    return `${noun}（${rest[1] ?? '?'} 个用户）`;
  if (prefix === 'scan-token' || tail === 'sync') return tail === 'sync' ? `${noun}同步` : noun;
  if (prefix === 'admin' && tail === 'self') return '自己的账号';
  if (prefix === 'config' || prefix === 'config-test') {
    return `${noun}：${getConfigGroup(tail)?.title ?? tail}`;
  }
  if (prefix === 'notification-template') {
    const [code = '', channel] = rest;
    const name = findNotificationEvent(code)?.name ?? code;
    return channel ? `${noun}：${name}（${CHANNELS[channel] ?? channel}）` : `${noun}：${name}`;
  }
  if (prefix === 'cms') {
    return `${rest[0] === 'article-category' ? '文章分类' : noun} #${rest[1] ?? '?'}`;
  }
  if (prefix === 'decor') {
    if (rest[0] === 'designation')
      return `${noun}：${DESIGNATIONS[rest[1] as Designation] ?? rest[1]}`;
    if (rest[0] === 'document') {
      return rest[2] === 'revision'
        ? `${noun}：页面 #${rest[1]} 第 ${rest[3]} 版`
        : `${noun}：页面 #${rest[1]}`;
    }
  }
  if (/^\d+(,\d+)*$/.test(tail)) return `${noun} ${ids(tail)}`;
  return tail === '' ? noun : `${noun} ${tail}`;
}
