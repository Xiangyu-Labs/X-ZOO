import { z } from 'zod';
import type { AnyRouteDef } from '@shop/contracts/conventions';
import { allRoutes } from '@shop/contracts/routes';

/**
 * The admin API as an agent sees it: every `/admin-api/**` route, found by
 * what it does rather than by URL, and described by the same zod schemas the
 * server validates with. Generated from the contracts at runtime, so a route
 * added tomorrow is an operation tomorrow — nothing here lists routes by hand
 * except the few an agent must not have.
 *
 * Shared by the MCP endpoint (`apps/web/app/mcp`) and the `shop` CLI.
 */

/**
 * Routes that are not operations for an agent:
 * - signing in and out is what the token replaces;
 * - changing one's own password would kill the very token making the call.
 * Every route marked `consoleOnly` (admins, roles, tokens) is left out too —
 * the server refuses a token on them anyway.
 */
const EXCLUDED = new Set([
  'auth.adminLogin',
  'auth.adminLogout',
  'system.profileChangePassword',
  'health.admin',
]);

/** 中文 names of the tags, for a client that lists what there is. */
export const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  auth: '账号',
  catalog: '商品',
  cms: '文章',
  coupon: '优惠券',
  decor: '页面装修',
  groupbuy: '拼团',
  notification: '通知',
  order: '订单',
  payment: '支付与资金',
  presale: '预售',
  refund: '售后退款',
  shipping: '物流与运费',
  stats: '数据统计',
  storage: '素材库',
  system: '系统（管理员、身份、配置、日志）',
  user: '用户',
  wechatOa: '微信公众号',
};

/**
 * Operations whose body is `multipart/form-data` (a file), not JSON — named
 * here rather than read off the summary, which is wording and may change.
 * `admin-ops.test.ts` checks the list against the contracts.
 */
const MULTIPART = new Set(['storage.attachmentUpload']);

export function isMultipart(id: string): boolean {
  return MULTIPART.has(id);
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  summary: string;
  domain: string;
  permission: string | null;
  /** The body is `multipart/form-data` (a file upload), not JSON. */
  multipart: boolean;
}

export interface OperationDetail extends Operation {
  params: unknown;
  query: unknown;
  body: unknown;
  /** Worked examples from the contract: the input parts only. */
  examples: { name: string; params?: unknown; query?: unknown; body?: unknown }[];
  errors: readonly string[];
}

function domainOf(route: AnyRouteDef): string {
  return route.id.slice(0, route.id.indexOf('.'));
}

function toOperation(route: AnyRouteDef): Operation {
  return {
    id: route.id,
    method: route.method,
    path: route.path,
    summary: route.summary,
    domain: domainOf(route),
    permission: route.permission ?? null,
    multipart: isMultipart(route.id),
  };
}

const adminRoutes: readonly AnyRouteDef[] = allRoutes.filter(
  (route) =>
    route.path.startsWith('/admin-api/') &&
    route.auth === 'admin' &&
    !EXCLUDED.has(route.id) &&
    route.consoleOnly !== true,
);
const byId = new Map(adminRoutes.map((route) => [route.id, route]));

export function listOperations(): Operation[] {
  return adminRoutes.map(toOperation);
}

export function findRoute(id: string): AnyRouteDef | null {
  return byId.get(id) ?? null;
}

/**
 * Words an operator says → words the summaries use. Summaries are terse and
 * consistent (新建 / 编辑 / 删除 / 列表 / 详情), people are not.
 */
const SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/添加|增加|新增|创建|加一个|加个|上新|^加/g, '新建'],
  [/修改|更改|更新|改成|改为|调整|设置|^改/g, '编辑 保存'],
  [/移除|删掉|去掉|^删/g, '删除'],
  [/查看|查询|看看|有哪些|所有|全部/g, '列表'],
  [/布局|首页装修|装修|页面/g, '装修'],
  [/图片|照片|图|素材/g, '素材'],
  [/账号|后台用户|管理员账号/g, '管理员'],
  [/角色|权限组/g, '身份'],
  [/备案|icp|站点|网站设置|网站名称/gi, '配置'],
  [/上架|下架/g, '上架'],
  [/退款|退货|售后/g, '退款'],
  [/销量|营业额|报表|统计/g, '统计'],
];

function normalise(query: string): string {
  let out = query.trim().toLowerCase();
  for (const [pattern, replacement] of SYNONYMS) out = out.replace(pattern, ` ${replacement} `);
  return out;
}

/**
 * What people call an operation that its summary does not say — the settings
 * that live inside a config group, mostly. Searched like the summary.
 */
const KEYWORDS: Readonly<Record<string, string>> = {
  'system.configSave': '备案 ICP 网站名称 站点 客服电话 版权 logo 短信 存储 支付 物流',
  'system.configGet': '备案 ICP 网站名称 站点 客服电话 版权 logo',
  'storage.attachmentImport': '网址 链接 图片 上传',
  'storage.scanTokenCreate': '手机 扫码 上传 照片',
};

function score(op: Operation, terms: string[], chars: Set<string>): number {
  const haystack = `${op.summary} ${KEYWORDS[op.id] ?? ''}`.toLowerCase();
  // The domain's label names everything in it ("系统（管理员、身份、配置…）"),
  // so it only breaks ties; otherwise every system operation matches "配置".
  const label = DOMAIN_LABELS[op.domain] ?? '';
  const idLower = op.id.toLowerCase();
  let points = 0;
  for (const term of terms) {
    if (haystack.includes(term)) points += 4;
    if (label.includes(term)) points += 1;
    if (idLower.includes(term)) points += 3;
    if (op.path.includes(term)) points += 1;
  }
  // Chinese has no spaces: count shared characters as a weak signal.
  for (const char of chars) if (haystack.includes(char)) points += 1;
  return points;
}

/**
 * Operations for a plain-language query, best first. `domain` narrows to one
 * area (`catalog`, `decor`…); an empty query with a domain lists that domain.
 */
export function searchOperations(
  query: string,
  options: { limit?: number; domain?: string } = {},
): Operation[] {
  const limit = options.limit ?? 15;
  const all = listOperations().filter((op) => !options.domain || op.domain === options.domain);
  const normalised = normalise(query);
  if (normalised.trim() === '') return all.slice(0, options.domain ? 100 : limit);
  const terms = normalised.split(/\s+/).filter((term) => term.length > 0);
  const chars = new Set([...normalised.replace(/[\sa-z0-9._/-]/g, '')]);
  return all
    .map((op) => ({ op, points: score(op, terms, chars) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points || a.op.id.localeCompare(b.op.id))
    .slice(0, limit)
    .map((entry) => entry.op);
}

function jsonSchemaOf(schema: z.ZodType | undefined): unknown {
  if (!schema) return null;
  try {
    // What the caller sends is the schema's *input* (before defaults and transforms).
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { description: '（此参数的结构无法自动描述，请参考示例）' };
  }
}

export function describeOperation(id: string): OperationDetail | null {
  const route = findRoute(id);
  if (!route) return null;
  return {
    ...toOperation(route),
    params: jsonSchemaOf(route.params),
    query: jsonSchemaOf(route.query),
    body: jsonSchemaOf(route.body),
    examples: route.examples.slice(0, 2).map((example) => ({
      name: example.name,
      ...(example.params === undefined ? {} : { params: example.params }),
      ...(example.query === undefined ? {} : { query: example.query }),
      ...(example.body === undefined ? {} : { body: example.body }),
    })),
    errors: route.errors ?? [],
  };
}
