/**
 * Plain constants of the DIY v2 (`decor`) data model.
 *
 * **Zod-free on purpose.** The storefront blocks import this file at runtime
 * and everything else in `decor/` as types only, so neither the mini-program
 * bundle nor the admin canvas bundle carries a validator (the mini-program's
 * size report fails the build if zod appears). Do not import zod here, and do
 * not import a file that does.
 */
import type { StorefrontRouteKey } from '../system/storefront-routes';

/** Which surface a document decorates. */
export const DOCUMENT_KINDS = {
  home: '首页',
  user_center: '个人中心',
  custom: '微页面',
} as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;

/** The two surfaces a document can be designated to serve (one document each). */
export const DESIGNATIONS = {
  home: '当前首页',
  user_center: '当前个人中心',
} as const;
export type Designation = keyof typeof DESIGNATIONS;

/**
 * Hard limits of one document. Checked on save (the envelope), on publish
 * (everything) and again by the storefront resolver, which never trusts a
 * stored row to be within them.
 */
export const DECOR_LIMITS = {
  /** Blocks on one page. */
  blocks: 60,
  /** Blocks on one page that need server data (products, coupons, …). Bounds the resolver's queries. */
  dataBlocks: 20,
  /** Serialised size of a draft or revision, in bytes. */
  documentBytes: 256 * 1024,
  /** Ids in one manual product list. */
  manualProducts: 20,
  /** Products an automatic (category / label) list may show. */
  autoProducts: 20,
  /** Records in one manual coupon / group-buy / presale / article list, and the automatic cap. */
  records: 10,
} as const;

/** Spacing preset → label. A theme retunes the steps in one place. */
export const SPACING = { none: '无', sm: '小', md: '中', lg: '大' } as const;
export type Spacing = keyof typeof SPACING;

export const RADIUS = { none: '直角', sm: '小圆角', lg: '大圆角' } as const;
export type Radius = keyof typeof RADIUS;

/** Who sees a block. */
export const AUDIENCES = {
  all: '所有人',
  guest: '仅未登录',
  member: '仅已登录',
} as const;
export type Audience = keyof typeof AUDIENCES;

/** The clients a block can be limited to (`X-Client-Platform`). Empty list = every client. */
export const PLATFORMS = {
  'wechat-mini': '微信小程序',
  h5: 'H5',
  'wechat-oa': '公众号网页',
} as const;
export type Platform = keyof typeof PLATFORMS;

export const LINK_KINDS = {
  product: '商品',
  category: '商品分类',
  article: '资讯',
  page: '微页面',
  route: '商城页面',
  webview: '网页',
  miniprogram: '其他小程序',
} as const;
export type LinkKind = keyof typeof LINK_KINDS;

/**
 * The catalogue routes a `route` link may offer without asking for params,
 * with the label the link picker shows. Every key is `linkable` and accepts
 * `params: {}` (`decor.test.ts` holds both ways). Routes that need a record —
 * a product, an article, a 微页面 — are chosen through their own link kinds.
 */
export const ROUTE_LINK_LABELS = {
  home: '首页',
  category: '分类',
  cart: '购物车',
  me: '我的',
  productList: '商品列表',
  search: '搜索',
  featured: '精选榜单',
  orderList: '我的订单',
  refundList: '售后/退款',
  groupbuyList: '拼团列表',
  presaleList: '预售列表',
  couponCenter: '领券中心',
  myCoupons: '我的优惠券',
  profile: '个人资料',
  settings: '设置',
  addresses: '收货地址',
  favorites: '我的收藏',
  history: '浏览记录',
  messages: '消息中心',
  invoices: '发票管理',
  articleList: '资讯列表',
  myReviews: '我的评价',
  myGroupbuys: '我的拼团',
} as const satisfies Partial<Record<StorefrontRouteKey, string>>;
export type RouteLinkKey = keyof typeof ROUTE_LINK_LABELS;

/** How an automatic product list is ordered. */
export const PRODUCT_SORT = {
  default: '默认',
  sales: '销量',
  newest: '最新',
  priceAsc: '价格从低到高',
  priceDesc: '价格从高到低',
} as const;
export type ProductSort = keyof typeof PRODUCT_SORT;

/** How a product list (商品列表, 商品选项卡) lays its cards out. */
export const PRODUCT_LAYOUTS = {
  grid2: '两列网格',
  grid3: '三列网格',
  list: '单列列表',
  scroll: '横向滑动',
} as const;
export type ProductLayout = keyof typeof PRODUCT_LAYOUTS;

/** The data slot of 商品选项卡 tab `index` (`block.data.tab0`, …). */
export function productTabSlot(index: number): string {
  return `tab${index}`;
}

/** Image-cube layout → its label and how many cells it shows. */
export const IMAGE_CUBE_LAYOUTS = {
  row2: { label: '一行两个', cells: 2 },
  row3: { label: '一行三个', cells: 3 },
  row4: { label: '一行四个', cells: 4 },
  grid2x2: { label: '两行两列', cells: 4 },
  left1right2: { label: '左一右二', cells: 3 },
  top1bottom2: { label: '上一下二', cells: 3 },
} as const;
export type ImageCubeLayout = keyof typeof IMAGE_CUBE_LAYOUTS;

/**
 * 订单入口: what one entry opens, and which `order.counts` badge it shows.
 * `unpaid` / `unshipped` / `unreceived` / `unreviewed` open `orderList { tab }`
 * with the same key; `aftersale` opens `refundList` with the `refunding` count.
 */
export const ORDER_ENTRY_KEYS = {
  unpaid: '待付款',
  unshipped: '待发货',
  unreceived: '待收货',
  unreviewed: '待评价',
  aftersale: '售后/退款',
} as const;
export type OrderEntryKey = keyof typeof ORDER_ENTRY_KEYS;

/** 优惠券: how the coupon tickets sit. */
export const COUPON_LIST_LAYOUTS = {
  scroll: '横向滑动',
  stack: '纵向排列',
} as const;
export type CouponListLayout = keyof typeof COUPON_LIST_LAYOUTS;

/** 拼团 / 预售: how the campaign cards sit. */
export const CAMPAIGN_LIST_LAYOUTS = {
  list: '单列列表',
  scroll: '横向滑动',
} as const;
export type CampaignListLayout = keyof typeof CAMPAIGN_LIST_LAYOUTS;

/** 资讯: a text row with a small cover, or a large cover card. */
export const ARTICLE_LIST_LAYOUTS = {
  list: '列表',
  card: '大图卡片',
} as const;
export type ArticleListLayout = keyof typeof ARTICLE_LIST_LAYOUTS;

/** 视频: the frame's aspect ratio, width : height. */
export const VIDEO_RATIOS = {
  '16:9': '16:9',
  '4:3': '4:3',
  '1:1': '1:1',
} as const;
export type VideoRatio = keyof typeof VIDEO_RATIOS;

/** 悬浮客服: which edge of the screen the button sits against. */
export const FLOATING_SIDES = { right: '右侧', left: '左侧' } as const;
export type FloatingSide = keyof typeof FLOATING_SIDES;

/** 悬浮客服: the button's distance from the bottom of the screen, in design px (750 wide). */
export const FLOATING_BOTTOM = { min: 120, max: 600, default: 240 } as const;
