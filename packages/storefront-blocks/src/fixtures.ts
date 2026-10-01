import type {
  ArticleListProps,
  CarouselProps,
  CouponListProps,
  FloatingContactProps,
  FollowOfficialAccountProps,
  GroupbuyListProps,
  HotspotImageProps,
  ImageCubeProps,
  NavGridProps,
  NewcomerCouponProps,
  NoticeProps,
  OrderEntryProps,
  PresaleListProps,
  ProductGridProps,
  ProductTabsProps,
  RichTextProps,
  SearchBarProps,
  ServiceGridProps,
  SpacerProps,
  TitleBarProps,
  UserCardProps,
  VideoProps,
} from '@shop/contracts/decor/all-blocks';
import { productTabSlot } from '@shop/contracts/decor/constants';
import type {
  ArticleSummary,
  CouponSummary,
  GroupbuySummary,
  PersonalSlot,
  PresaleSummary,
  ProductSummary,
} from '@shop/contracts/decor/sources';

/**
 * Fixture data for tests, the admin spike page, the fidelity script and the
 * mini-program's dev page: the *same* props and data on every surface, so a
 * difference in pixels is a difference in rendering.
 *
 * Images are inline SVG data URIs — deterministic, no network, no uploads —
 * and carry no text, so font rendering never enters an image.
 */

function svg(width: number, height: number, body: string): string {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function banner(from: string, to: string, accent: string): string {
  return svg(
    750,
    340,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
      `<rect width="750" height="340" fill="url(#g)"/>` +
      `<circle cx="600" cy="120" r="140" fill="${accent}" fill-opacity=".35"/>` +
      `<rect x="60" y="90" width="300" height="44" rx="22" fill="#fff" fill-opacity=".9"/>` +
      `<rect x="60" y="160" width="200" height="28" rx="14" fill="#fff" fill-opacity=".6"/>`,
  );
}

function square(hue: number): string {
  return svg(
    400,
    400,
    `<rect width="400" height="400" fill="hsl(${hue} 60% 88%)"/>` +
      `<circle cx="200" cy="170" r="110" fill="hsl(${hue} 65% 60%)"/>` +
      `<rect x="90" y="300" width="220" height="36" rx="18" fill="hsl(${hue} 55% 45%)"/>`,
  );
}

function tile(width: number, height: number, hue: number): string {
  return svg(
    width,
    height,
    `<rect width="${width}" height="${height}" fill="hsl(${hue} 70% 62%)"/>` +
      `<rect x="${width * 0.1}" y="${height * 0.14}" width="${width * 0.5}" height="${height * 0.12}" rx="${height * 0.06}" fill="#fff" fill-opacity=".85"/>` +
      `<circle cx="${width * 0.72}" cy="${height * 0.66}" r="${Math.min(width, height) * 0.22}" fill="#fff" fill-opacity=".35"/>`,
  );
}

export const fixtureCarousel: CarouselProps = {
  slides: [
    {
      image: banner('#ff7a45', '#e93323', '#ffd666'),
      alt: '秋季上新',
      link: { kind: 'route', to: { route: 'couponCenter', params: {} } },
    },
    {
      image: banner('#36cfc9', '#1677ff', '#b37feb'),
      alt: '爆款直降',
      link: { kind: 'product', id: '12' },
    },
    {
      image: banner('#95de64', '#389e0d', '#fff566'),
      alt: '新人专享',
      link: { kind: 'category', id: '3' },
    },
  ],
  height: 340,
  // Off in fixtures: a screenshot must not catch the slider mid-transition.
  autoplay: false,
  interval: 3000,
  indicator: 'dots',
  indicatorColor: '#ffffff80',
  indicatorActiveColor: '#ffffff',
  style: { marginY: 'none', paddingX: 'none', radius: 'none' },
  visibility: { audience: 'all', platforms: [] },
};

export const fixtureProducts: ProductSummary[] = [
  {
    id: '12',
    title: '秋季新款宽松针织开衫 女士百搭外套',
    image: square(12),
    price: '129.90',
    marketPrice: '199.00',
    tag: '新品',
  },
  {
    id: '13',
    title: '云南古树普洱茶饼 357g',
    image: square(30),
    price: '88.00',
    marketPrice: '128.00',
  },
  {
    id: '14',
    title: '主动降噪真无线蓝牙耳机 长续航',
    image: square(210),
    price: '299.00',
    tag: '热卖',
  },
  { id: '15', title: '厨房收纳三件套', image: square(150), price: '39.90', marketPrice: '59.90' },
  {
    id: '16',
    title: '儿童绘本套装（全 10 册）精装版 睡前故事',
    image: square(280),
    price: '76.50',
    tag: '特价',
  },
  { id: '17', title: '不锈钢保温杯 500ml', image: square(330), price: '49.00' },
];

export const fixtureProductGrid: ProductGridProps = {
  source: { mode: 'manual', ids: fixtureProducts.map((product) => product.id) },
  layout: 'grid2',
  titleLines: 2,
  showMarketPrice: true,
  showTag: true,
  style: { marginY: 'none', paddingX: 'none', radius: 'none' },
  visibility: { audience: 'all', platforms: [] },
};

export const fixtureImageCube: ImageCubeProps = {
  layout: 'left1right2',
  cells: [
    {
      image: tile(360, 360, 5),
      link: { kind: 'route', to: { route: 'groupbuyList', params: {} } },
    },
    { image: tile(360, 175, 45), link: { kind: 'article', id: '7' } },
    { image: tile(360, 175, 190), link: { kind: 'webview', url: 'https://example.com/promo' } },
    { image: tile(360, 175, 260) },
  ],
  height: 360,
  gap: 10,
  style: { marginY: 'sm', paddingX: 'md', radius: 'none' },
  visibility: { audience: 'all', platforms: [] },
};

/** A row layout, to exercise `widthFix`. */
export const fixtureImageCubeRow: ImageCubeProps = {
  ...fixtureImageCube,
  layout: 'row3',
  cells: [
    { image: tile(230, 300, 20) },
    { image: tile(230, 300, 100) },
    { image: tile(230, 300, 220) },
  ],
};

const frame = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
const everyone = { audience: 'all', platforms: [] as [] } as const;

/** A round, flat icon: a coloured disc with a white mark, no text. */
function navIcon(hue: number, mark: string): string {
  return svg(
    96,
    96,
    `<circle cx="48" cy="48" r="48" fill="hsl(${hue} 55% 58%)"/>` +
      `<g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${mark}</g>`,
  );
}

const MARKS = [
  '<rect x="28" y="30" width="40" height="36" rx="6"/><path d="M28 42h40"/>',
  '<path d="M48 26l6 13 14 2-10 10 2 14-12-7-12 7 2-14-10-10 14-2z"/>',
  '<circle cx="48" cy="48" r="18"/><path d="M48 38v10l7 5"/>',
  '<path d="M30 60V36l18-10 18 10v24H30z"/><path d="M42 60V48h12v12"/>',
  '<path d="M32 36h32l-4 26H36z"/><path d="M40 36a8 8 0 0 1 16 0"/>',
];

export const fixtureSearchBar: SearchBarProps = {
  placeholder: '搜索商品',
  hotWords: [{ word: '新品' }, { word: '礼盒' }, { word: '包邮' }],
  shape: 'round',
  sticky: false,
  style: frame,
  visibility: everyone,
};

export const fixtureNavGrid: NavGridProps = {
  items: ['新品', '热卖', '限时', '好店', '礼物', '领券', '会员', '积分', '拼团', '全部'].map(
    (label, index) => ({
      icon: navIcon((index * 36) % 360, MARKS[index % MARKS.length] as string),
      label,
      link: { kind: 'category', id: String(index + 1) },
    }),
  ),
  columns: 5,
  rows: 2,
  paging: false,
  iconShape: 'circle',
  style: frame,
  visibility: everyone,
};

export const fixtureNotice: NoticeProps = {
  label: '公告',
  lines: [
    {
      text: '全场满 199 元包邮，隐私包装发货',
      link: { kind: 'route', to: { route: 'couponCenter', params: {} } },
    },
    { text: '国庆假期正常发货' },
  ],
  // `static` in fixtures: a screenshot must not catch a rolling line mid-way.
  mode: 'static',
  interval: 4000,
  style: frame,
  visibility: everyone,
};

export const fixtureHotspotImage: HotspotImageProps = {
  image: svg(
    750,
    360,
    `<rect width="375" height="360" fill="hsl(200 55% 70%)"/><rect x="375" width="375" height="360" fill="hsl(20 65% 72%)"/>` +
      `<rect x="60" y="130" width="250" height="100" rx="50" fill="#fff" fill-opacity=".9"/>` +
      `<rect x="435" y="130" width="250" height="100" rx="50" fill="#fff" fill-opacity=".9"/>`,
  ),
  hotspots: [
    { x: 8, y: 36, w: 33.3, h: 27.8, label: '左侧活动', link: { kind: 'product', id: '12' } },
    { x: 58, y: 36, w: 33.3, h: 27.8, label: '右侧活动', link: { kind: 'category', id: '3' } },
  ],
  style: frame,
  visibility: everyone,
};

export const fixtureTitleBar: TitleBarProps = {
  title: '热卖推荐',
  subtitle: '大家都在买',
  align: 'left',
  moreText: '更多',
  moreLink: { kind: 'category', id: '3' },
  style: frame,
  visibility: everyone,
};

export const fixtureProductTabs: ProductTabsProps = {
  tabs: [
    { title: '推荐', source: { mode: 'manual', ids: ['12', '13', '14', '15'] } },
    { title: '新品', source: { mode: 'manual', ids: ['16', '17'] } },
    { title: '热卖', source: { mode: 'manual', ids: ['14', '12'] } },
  ],
  layout: 'grid2',
  titleLines: 2,
  showMarketPrice: true,
  showTag: true,
  style: frame,
  visibility: everyone,
};

/** The products each tab resolves to, by slot. */
export const fixtureProductTabsData: Record<string, ProductSummary[]> = {};
// Not Object.fromEntries: the demo sub-package renders these on phones, and iOS 12.0/12.1 lack it.
fixtureProductTabs.tabs.forEach((tab, index) => {
  fixtureProductTabsData[productTabSlot(index)] = resolveFixtureProducts(tab.source);
});

export const fixtureRichText: RichTextProps = {
  html:
    '<h3>购物须知</h3><p>所有商品均为<strong>隐私包装</strong>，外包装不显示商品名称。</p>' +
    '<ul><li>支持七天无理由退换</li><li>顺丰包邮，48 小时内发货</li></ul>',
  style: frame,
  visibility: everyone,
};

export const fixtureSpacer: SpacerProps = {
  height: 40,
  line: 'solid',
  inset: true,
  style: frame,
  visibility: everyone,
};

export const fixtureUserCard: UserCardProps = {
  showStats: true,
  style: frame,
  visibility: everyone,
};

export const fixtureOrderEntry: OrderEntryProps = {
  title: '我的订单',
  items: [
    { key: 'unpaid', label: '待付款' },
    { key: 'unshipped', label: '待发货' },
    { key: 'unreceived', label: '待收货' },
    { key: 'unreviewed', label: '待评价' },
    { key: 'aftersale', label: '售后/退款' },
  ],
  style: { ...frame, marginY: 'sm', paddingX: 'sm', radius: 'sm' },
  visibility: everyone,
};

export const fixtureServiceGrid: ServiceGridProps = {
  title: '我的服务',
  columns: 4,
  items: [
    {
      label: '优惠券',
      action: 'link',
      link: { kind: 'route', to: { route: 'myCoupons', params: {} } },
    },
    {
      label: '收货地址',
      action: 'link',
      link: { kind: 'route', to: { route: 'addresses', params: {} } },
    },
    {
      label: '我的收藏',
      action: 'link',
      link: { kind: 'route', to: { route: 'favorites', params: {} } },
    },
    { label: '联系客服', action: 'contact' },
  ],
  style: { ...frame, marginY: 'sm', paddingX: 'sm', radius: 'sm' },
  visibility: everyone,
};

/** A signed-in shopper's state for the 个人中心 blocks, by slot. */
export const fixturePersonal: {
  userCard: Record<string, PersonalSlot>;
  orderEntry: Record<string, PersonalSlot>;
} = {
  userCard: {
    user: {
      kind: 'userSummary',
      user: {
        nickname: '小林',
        avatarUrl: navIcon(210, MARKS[2] as string),
        stats: { coupons: 3, favorites: 12, history: 28 },
      },
    },
  },
  orderEntry: {
    counts: {
      kind: 'orderCounts',
      counts: { unpaid: 1, unshipped: 2, unreceived: 0, aftersale: 120 },
    },
  },
};

/** Resolves a product grid's source against the fixtures, as the server resolver will. */
export function resolveFixtureProducts(source: ProductGridProps['source']): ProductSummary[] {
  if (source.mode === 'manual') {
    return source.ids.flatMap((id) => fixtureProducts.find((product) => product.id === id) ?? []);
  }
  const sorted = [...fixtureProducts];
  if (source.sort === 'priceAsc') sorted.sort((a, b) => fen(a.price) - fen(b.price));
  if (source.sort === 'newest') sorted.reverse();
  return sorted.slice(0, source.limit);
}

/** `"129.90"` → 12990: integer fen, never a float. */
function fen(price: string): number {
  return Number.parseInt(price.replace('.', ''), 10);
}

// ---------------------------------------------------------------------------
// batch 2 (G2): marketing, content and floating blocks
// ---------------------------------------------------------------------------

/**
 * The instant the fixtures are drawn at: what a host passes as
 * `host.serverNow`, so the 预售 countdown reads the same on every surface.
 */
export const FIXTURE_NOW = Date.parse('2026-06-01T04:00:00.000Z');
export const fixtureServerNow = (): number => FIXTURE_NOW;

const coupon = (
  templateId: string,
  name: string,
  discountAmount: string,
  minSpend: string,
  validity: { validDays: number } | { validFrom: string; validTo: string },
): CouponSummary => ({
  templateId,
  name,
  discountAmount,
  minSpend,
  scope: 'all_products',
  validityMode: 'validDays' in validity ? 'days_after_claim' : 'fixed_window',
  validFrom: 'validFrom' in validity ? validity.validFrom : null,
  validTo: 'validTo' in validity ? validity.validTo : null,
  validDays: 'validDays' in validity ? validity.validDays : null,
  claimTo: null,
  isUnlimitedSupply: false,
  remainingCount: 100,
  perUserLimit: 1,
});

export const fixtureCoupons: CouponSummary[] = [
  coupon('21', '全场通用券', '10.00', '99.00', { validDays: 7 }),
  coupon('22', '无门槛券', '5.00', '0.00', {
    validFrom: '2026-05-31T16:00:00.000Z',
    validTo: '2026-06-30T15:59:59.000Z',
  }),
  coupon('23', '满减券', '30.00', '199.00', { validDays: 15 }),
];

export const fixtureCouponList: CouponListProps = {
  title: '领券中心',
  showMore: true,
  source: { mode: 'auto', limit: 3 },
  layout: 'scroll',
  style: frame,
  visibility: everyone,
};

export const fixtureNewUserCoupons: CouponSummary[] = [
  coupon('31', '新人券', '10.00', '0.00', { validDays: 7 }),
  coupon('32', '新人券', '20.00', '129.00', { validDays: 7 }),
  coupon('33', '新人券', '50.00', '299.00', { validDays: 7 }),
];

export const fixtureNewcomerCoupon: NewcomerCouponProps = {
  title: '新人专享',
  subtitle: '注册即得，下单立减',
  limit: 3,
  style: frame,
  visibility: everyone,
};

const campaignStart = '2026-05-20T00:00:00.000Z';

export const fixtureGroupbuys: GroupbuySummary[] = [
  {
    activityId: '41',
    productId: '12',
    title: '秋季新款宽松针织开衫 女士百搭外套',
    intro: null,
    imageUrl: square(12),
    price: '99.00',
    originalPrice: '129.90',
    seatsRequired: 2,
    stock: 50,
    sales: 36,
    startAt: campaignStart,
    endAt: '2026-06-10T16:00:00.000Z',
    formingGroups: 3,
    canBuy: true,
  },
  {
    activityId: '42',
    productId: '15',
    title: '厨房收纳三件套',
    intro: null,
    imageUrl: square(150),
    price: '29.90',
    originalPrice: '39.90',
    seatsRequired: 3,
    stock: 80,
    sales: 0,
    startAt: campaignStart,
    endAt: '2026-06-10T16:00:00.000Z',
    formingGroups: 0,
    canBuy: true,
  },
];

export const fixtureGroupbuyList: GroupbuyListProps = {
  title: '拼团',
  showMore: true,
  source: { mode: 'auto', limit: 3 },
  layout: 'list',
  style: frame,
  visibility: everyone,
};

export const fixturePresales: PresaleSummary[] = [
  {
    activityId: '51',
    productId: '14',
    title: '主动降噪真无线蓝牙耳机 长续航',
    intro: null,
    imageUrl: square(210),
    price: '259.00',
    originalPrice: '299.00',
    stock: 20,
    sales: 8,
    startAt: campaignStart,
    // 2 days, 3 h 4 min 5 s after FIXTURE_NOW.
    endAt: '2026-06-03T07:04:05.000Z',
    shipAfterDays: 15,
    canBuy: true,
  },
  {
    activityId: '52',
    productId: '16',
    title: '儿童绘本套装（全 10 册）精装版 睡前故事',
    intro: null,
    imageUrl: square(280),
    price: '69.00',
    originalPrice: null,
    stock: 20,
    sales: 0,
    startAt: campaignStart,
    endAt: '2026-06-01T05:30:00.000Z',
    shipAfterDays: 0,
    canBuy: true,
  },
];

export const fixturePresaleList: PresaleListProps = {
  title: '预售',
  showMore: true,
  source: { mode: 'auto', limit: 3 },
  layout: 'list',
  showCountdown: true,
  style: frame,
  visibility: everyone,
};

export const fixtureArticles: ArticleSummary[] = [
  {
    id: '61',
    title: '换季护理指南：秋冬如何挑选合适的面料',
    coverImageUrl: tile(400, 280, 200),
    summary: '从面料成分到洗涤方式，一篇讲清楚。',
    author: null,
    categoryTitle: '生活指南',
    views: 1203,
    publishedAt: '2026-05-28T02:00:00.000Z',
  },
  {
    id: '62',
    title: '门店营业时间调整通知',
    coverImageUrl: null,
    summary: null,
    author: null,
    categoryTitle: '店铺公告',
    views: 88,
    publishedAt: '2026-05-20T02:00:00.000Z',
  },
];

export const fixtureArticleList: ArticleListProps = {
  title: '资讯',
  showMore: true,
  source: { mode: 'category', limit: 3 },
  layout: 'list',
  style: frame,
  visibility: everyone,
};

export const fixtureVideo: VideoProps = {
  src: '/fixtures/intro.mp4',
  poster: banner('#434343', '#1f1f1f', '#8c8c8c'),
  ratio: '16:9',
  autoplay: false,
  muted: false,
  loop: false,
  style: frame,
  visibility: everyone,
};

export const fixtureFloatingContact: FloatingContactProps = {
  label: '客服',
  side: 'right',
  bottom: 240,
  style: frame,
  visibility: everyone,
};

export const fixtureFollowOfficialAccount: FollowOfficialAccountProps = {
  style: frame,
  visibility: everyone,
};

/** A signed-in shopper's state for the batch-2 blocks, by slot. */
export const fixturePersonalG2: {
  couponList: Record<string, PersonalSlot>;
  newcomerCoupon: Record<string, PersonalSlot>;
} = {
  couponList: {
    coupons: {
      kind: 'coupons',
      items: [
        { templateId: '21', claimedCount: 1, canClaim: false },
        { templateId: '22', claimedCount: 1, canClaim: true },
        { templateId: '23', claimedCount: 0, canClaim: true },
      ],
    },
  },
  newcomerCoupon: {
    held: {
      kind: 'newcomerCoupons',
      coupons: [
        {
          id: '901',
          templateId: '31',
          title: '新人券',
          discountAmount: '10.00',
          minSpend: '0.00',
          validTo: '2026-06-07T15:59:59.000Z',
        },
      ],
    },
  },
};
