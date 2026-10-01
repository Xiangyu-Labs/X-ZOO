import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NewAgreement, NewCity, NewExpressCompany } from '../schema/reference';
import type { NewNotificationTemplate } from '../schema/notification';

/**
 * The reference rows the seed inserts.
 *
 * Cities and courier companies come from the committed `seed-data/*.json`.
 * Agreements and notification templates are seeded as **shells**: the code and
 * the title are the contract the application relies on, the body is
 * installation-specific and is typed by an operator.
 */

const seedDataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../seed-data');

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`${seedDataDir}/${name}`, 'utf8')) as T;
}

export async function loadCities(): Promise<NewCity[]> {
  return readJson<NewCity[]>('cities.json');
}

export async function loadExpressCompanies(): Promise<NewExpressCompany[]> {
  return readJson<NewExpressCompany[]>('express-companies.json');
}

/**
 * Legal texts. There is no 付费会员协议, 代理商规则, 积分协议 or 分销说明 —
 * they described retired features.
 */
export const agreementShells: NewAgreement[] = [
  { code: 'user_service', title: '用户协议', sortOrder: 10 },
  { code: 'privacy_policy', title: '隐私协议', sortOrder: 20 },
  { code: 'account_cancellation', title: '注销协议', sortOrder: 30 },
  { code: 'about_us', title: '关于我们', sortOrder: 40 },
];

/**
 * Notification template keys, named as English events.
 *
 * `revenue_received` (收益到账) is absent: it belonged to the brokerage system.
 */
export const notificationTemplateShells: NewNotificationTemplate[] = [
  { code: 'sms_verify_code', name: '短信验证码', audience: 'user', variables: ['code'] },
  {
    code: 'order_paid',
    name: '支付成功提醒',
    audience: 'user',
    variables: ['orderNo', 'amount', 'productName'],
  },
  {
    code: 'order_shipped',
    name: '发货提醒',
    audience: 'user',
    variables: ['orderNo', 'expressName', 'trackingNo'],
  },
  {
    code: 'order_delivered_by_merchant',
    name: '送货提醒',
    audience: 'user',
    variables: ['orderNo', 'courierName', 'courierPhone'],
  },
  { code: 'order_received', name: '确认收货提醒', audience: 'user', variables: ['orderNo'] },
  {
    code: 'order_refund_succeeded',
    name: '退款成功提醒',
    audience: 'user',
    variables: ['orderNo', 'amount'],
  },
  {
    code: 'order_refund_failed',
    name: '退款失败提醒',
    audience: 'user',
    variables: ['orderNo', 'reason'],
  },
  {
    code: 'order_price_revised',
    name: '改价提醒',
    audience: 'user',
    variables: ['orderNo', 'amount'],
  },
  { code: 'groupbuy_created', name: '开团成功提醒', audience: 'user', variables: ['orderNo'] },
  { code: 'groupbuy_joined', name: '参团成功提醒', audience: 'user', variables: ['orderNo'] },
  {
    code: 'groupbuy_succeeded',
    name: '拼团成功提醒',
    audience: 'user',
    variables: ['orderNo', 'productName'],
  },
  { code: 'groupbuy_failed', name: '拼团失败提醒', audience: 'user', variables: ['orderNo'] },
  { code: 'groupbuy_cancelled', name: '取消拼团提醒', audience: 'user', variables: ['orderNo'] },
  {
    code: 'admin_order_paid',
    name: '用户下单提醒',
    audience: 'admin',
    variables: ['orderNo', 'amount'],
  },
  { code: 'admin_order_received', name: '用户收货提醒', audience: 'admin', variables: ['orderNo'] },
  {
    code: 'admin_refund_applied',
    name: '用户申请退款提醒',
    audience: 'admin',
    variables: ['orderNo', 'amount'],
  },
];
