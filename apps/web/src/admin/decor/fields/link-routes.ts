import { ROUTE_LINK_LABELS } from '@shop/contracts/decor/constants';
import {
  storefrontRoute,
  storefrontRouteDef,
  storefrontRouteKeys,
  type StorefrontRoute,
  type StorefrontRouteKey,
} from '@shop/contracts/system/storefront-routes';

import type { DecorRecordKind } from '../records';

/**
 * Every catalogue route a `route` link may open, with the controls for its
 * params — the link picker's table.
 *
 * The catalogue (`system/storefront-routes.ts`) decides *which* routes are
 * linkable and what their params must parse as; this table only says how the
 * editor asks for each param. `link-routes.test.ts` holds the two in step:
 * every linkable key has a row, every param of its schema has a control, and
 * every value of an enum param has a label. A route added to the catalogue as
 * `linkable` therefore fails that test until it is described here.
 *
 * Params are query-string values, so every control yields a string.
 */

export type RouteParamControl =
  /** An id picked from the shop's records. */
  | { kind: 'record'; label: string; record: DecorRecordKind }
  /** An id picked from a category tree. */
  | { kind: 'category'; label: string; tree: 'product' | 'article' }
  /** One value of the param's enum; `options` labels every value. */
  | { kind: 'enum'; label: string; options: Readonly<Record<string, string>> }
  | { kind: 'text'; label: string; placeholder?: string }
  /**
   * Not offered: a param that only makes sense from inside the storefront
   * (the address book's pick mode from checkout). A link never sets it.
   */
  | { kind: 'internal' };

export interface LinkRouteSpec {
  label: string;
  params: Readonly<Record<string, RouteParamControl>>;
}

const productCategory: RouteParamControl = {
  kind: 'category',
  label: '商品分类',
  tree: 'product',
};

/** The linkable catalogue keys, in the order the picker lists them. */
export const LINK_ROUTES = {
  home: { label: ROUTE_LINK_LABELS.home, params: {} },
  category: {
    label: ROUTE_LINK_LABELS.category,
    params: { categoryId: { ...productCategory, label: '默认展开的分类' } },
  },
  cart: { label: ROUTE_LINK_LABELS.cart, params: {} },
  me: { label: ROUTE_LINK_LABELS.me, params: {} },
  product: {
    label: '商品详情',
    params: { id: { kind: 'record', label: '商品', record: 'product' } },
  },
  productList: {
    label: ROUTE_LINK_LABELS.productList,
    params: {
      categoryId: productCategory,
      keyword: { kind: 'text', label: '搜索词', placeholder: '按关键词筛选' },
      labelId: { kind: 'record', label: '商品标签', record: 'label' },
      couponId: { kind: 'record', label: '可用优惠券', record: 'coupon' },
    },
  },
  search: {
    label: ROUTE_LINK_LABELS.search,
    params: { keyword: { kind: 'text', label: '预填搜索词' } },
  },
  featured: {
    label: ROUTE_LINK_LABELS.featured,
    params: {
      tab: {
        kind: 'enum',
        label: '榜单',
        options: { hot: '热门榜单', new: '首发新品', best: '精品推荐', benefit: '促销单品' },
      },
    },
  },
  orderList: {
    label: ROUTE_LINK_LABELS.orderList,
    params: {
      tab: {
        kind: 'enum',
        label: '默认标签',
        options: {
          all: '全部',
          unpaid: '待付款',
          unshipped: '待发货',
          shipping: '部分发货',
          unreceived: '待收货',
          finished: '已完成',
          cancelled: '已取消',
          refunding: '售后中',
          unreviewed: '待评价',
        },
      },
    },
  },
  refundList: {
    label: ROUTE_LINK_LABELS.refundList,
    params: {
      state: {
        kind: 'enum',
        label: '默认标签',
        options: { all: '全部', open: '处理中', succeeded: '已退款', closed: '已关闭' },
      },
    },
  },
  groupbuyList: { label: ROUTE_LINK_LABELS.groupbuyList, params: {} },
  groupbuy: {
    label: '拼团活动',
    params: { id: { kind: 'record', label: '拼团活动', record: 'groupbuy' } },
  },
  presaleList: { label: ROUTE_LINK_LABELS.presaleList, params: {} },
  presale: {
    label: '预售活动',
    params: { id: { kind: 'record', label: '预售活动', record: 'presale' } },
  },
  couponCenter: { label: ROUTE_LINK_LABELS.couponCenter, params: {} },
  myCoupons: {
    label: ROUTE_LINK_LABELS.myCoupons,
    params: {
      state: {
        kind: 'enum',
        label: '默认标签',
        options: { unused: '未使用', used: '已使用', expired: '已过期' },
      },
    },
  },
  profile: { label: ROUTE_LINK_LABELS.profile, params: {} },
  settings: { label: ROUTE_LINK_LABELS.settings, params: {} },
  addresses: { label: ROUTE_LINK_LABELS.addresses, params: { select: { kind: 'internal' } } },
  favorites: { label: ROUTE_LINK_LABELS.favorites, params: {} },
  history: { label: ROUTE_LINK_LABELS.history, params: {} },
  messages: { label: ROUTE_LINK_LABELS.messages, params: {} },
  invoices: {
    label: ROUTE_LINK_LABELS.invoices,
    params: {
      tab: {
        kind: 'enum',
        label: '默认标签',
        options: { titles: '发票抬头', records: '开票记录' },
      },
    },
  },
  agreement: {
    label: '协议',
    params: {
      key: {
        kind: 'enum',
        label: '协议',
        options: { user: '用户协议', privacy: '隐私政策', cancellation: '注销协议' },
      },
    },
  },
  articleList: {
    label: ROUTE_LINK_LABELS.articleList,
    params: { categoryId: { kind: 'category', label: '资讯分类', tree: 'article' } },
  },
  article: {
    label: '资讯详情',
    params: { id: { kind: 'record', label: '资讯', record: 'article' } },
  },
  page: {
    label: '微页面',
    params: { id: { kind: 'record', label: '微页面', record: 'page' } },
  },
  myReviews: { label: ROUTE_LINK_LABELS.myReviews, params: {} },
  myGroupbuys: { label: ROUTE_LINK_LABELS.myGroupbuys, params: {} },
} as const satisfies Partial<Record<StorefrontRouteKey, LinkRouteSpec>>;

export type LinkRouteKey = keyof typeof LINK_ROUTES;

export const LINK_ROUTE_KEYS = Object.keys(LINK_ROUTES) as LinkRouteKey[];

/** The catalogue's linkable keys, from the catalogue itself (for the test). */
export function catalogueLinkableKeys(): StorefrontRouteKey[] {
  return storefrontRouteKeys.filter((key) => storefrontRouteDef(key).linkable === true);
}

export function linkRouteSpec(route: string): LinkRouteSpec | undefined {
  return Object.hasOwn(LINK_ROUTES, route) ? LINK_ROUTES[route as LinkRouteKey] : undefined;
}

/** Whether the param must be given, from the catalogue's schema. */
export function isParamRequired(route: StorefrontRouteKey, param: string): boolean {
  const params = storefrontRouteDef(route).params as unknown as {
    shape?: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  };
  const schema = params.shape?.[param];
  return schema ? !schema.safeParse(undefined).success : false;
}

/**
 * The route as a link would store it: empty params dropped, then checked
 * against the catalogue. `issue` is the first thing still missing or wrong.
 */
export function checkRoute(
  route: string,
  params: Readonly<Record<string, string | undefined>>,
): { ok: true; route: StorefrontRoute } | { ok: false; issue: string } {
  const spec = linkRouteSpec(route);
  if (!spec) return { ok: false, issue: '该页面不能作为装修链接' };
  const kept = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
  );
  for (const [param, control] of Object.entries(spec.params)) {
    if (
      control.kind !== 'internal' &&
      kept[param] === undefined &&
      isParamRequired(route as StorefrontRouteKey, param)
    ) {
      return { ok: false, issue: `请选择${control.label}` };
    }
  }
  const parsed = storefrontRoute.safeParse({ route, params: kept });
  if (!parsed.success) {
    return { ok: false, issue: parsed.error.issues[0]?.message ?? '链接参数无效' };
  }
  return { ok: true, route: parsed.data };
}
