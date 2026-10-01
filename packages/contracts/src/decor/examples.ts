import type { DecorBlockType } from './all-blocks';
import type { PageDocument } from './document';
import type {
  DecorDocumentDetail,
  DecorDocumentSummary,
  ResolvedPage,
  RevisionSummary,
} from './schemas';

/**
 * Example payloads for the decor routes (the mock server serves the first of
 * each), and one example of every block's props (`decorBlockExamples`), which
 * `decor.test.ts` holds to each block's schema.
 */

const IMAGE = 'https://cdn.example.com/uploads/decor/banner-1.jpg';
const style = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
const visibility = { audience: 'all', platforms: [] } as const;

export const decorDocumentExample: PageDocument = {
  schemaVersion: 2,
  root: {
    props: { title: '首页', background: '#f5f5f5', shareEnabled: true, shareTitle: '' },
  },
  blocks: [
    {
      id: 'b-carousel',
      type: 'carousel',
      v: 1,
      props: {
        slides: [{ image: IMAGE, link: { kind: 'product', id: '12' }, alt: '新品上市' }],
        height: 340,
        autoplay: true,
        interval: 3000,
        indicator: 'dots',
        indicatorColor: '#ffffff80',
        indicatorActiveColor: '#ffffff',
        style,
        visibility,
      },
    },
    {
      id: 'b-grid',
      type: 'productGrid',
      v: 2,
      props: {
        source: { mode: 'category', categoryId: '3', sort: 'sales', limit: 4 },
        layout: 'grid2',
        titleLines: 2,
        showMarketPrice: true,
        showTag: true,
        style: { ...style, marginY: 'sm' },
        visibility,
      },
    },
  ],
};

export const revisionSummaryExample: RevisionSummary = {
  id: '41',
  number: 3,
  note: '国庆活动',
  authorAdminId: '1',
  restoredFrom: null,
  createdAt: '2026-09-23T10:00:00+08:00',
};

export const decorDocumentSummaryExample: DecorDocumentSummary = {
  id: '7',
  kind: 'home',
  name: '国庆首页',
  title: '首页',
  designation: 'home',
  draftVersion: '12',
  published: revisionSummaryExample,
  hasUnpublishedChanges: false,
  createdAt: '2026-09-20T09:00:00+08:00',
  updatedAt: '2026-09-23T10:00:00+08:00',
};

export const decorDocumentDetailExample: DecorDocumentDetail = {
  ...decorDocumentSummaryExample,
  draft: decorDocumentExample,
  issues: [],
  warnings: [],
};

export const resolvedPageExample: ResolvedPage = {
  id: '7',
  kind: 'home',
  revision: 3,
  preview: false,
  root: decorDocumentExample.root,
  blocks: [
    { ...(decorDocumentExample.blocks[0] as PageDocument['blocks'][number]), data: {} },
    {
      ...(decorDocumentExample.blocks[1] as PageDocument['blocks'][number]),
      data: {
        products: [
          {
            id: '12',
            title: '秋季新款针织开衫',
            image: 'https://cdn.example.com/uploads/product/12.jpg',
            price: '129.00',
            marketPrice: '199.00',
            tag: '热卖',
          },
          {
            id: '31',
            title: '纯棉长袖T恤',
            image: 'https://cdn.example.com/uploads/product/31.jpg',
            price: '59.00',
          },
        ],
      },
    },
  ],
  personal: null,
  version: 'rev-41',
  resolvedAt: '2026-09-23T10:05:00+08:00',
};

const ICON = 'https://cdn.example.com/uploads/decor/icon-1.png';
const toRoute = (route: 'search' | 'couponCenter' | 'favorites' | 'myCoupons') =>
  ({ kind: 'route', to: { route, params: {} } }) as const;

/** One valid, fully defaulted props object per block type, as `checkDocument` stores it. */
export const decorBlockExamples: Record<DecorBlockType, Record<string, unknown>> = {
  searchBar: {
    placeholder: '搜索商品',
    hotWords: [{ word: '新品' }, { word: '礼盒' }],
    shape: 'round',
    sticky: true,
    style,
    visibility,
  },
  carousel: decorDocumentExample.blocks[0]?.props ?? {},
  navGrid: {
    items: [
      { icon: ICON, label: '领券', link: toRoute('couponCenter') },
      { icon: ICON, label: '新品', link: { kind: 'category', id: '3' } },
      { icon: ICON, label: '收藏', link: toRoute('favorites') },
      { icon: ICON, label: '优惠券', link: toRoute('myCoupons') },
    ],
    columns: 4,
    rows: 1,
    paging: false,
    iconShape: 'circle',
    style,
    visibility,
  },
  notice: {
    label: '公告',
    lines: [
      { text: '全场满 199 元包邮，隐私发货', link: toRoute('couponCenter') },
      { text: '国庆假期正常发货' },
    ],
    mode: 'scroll',
    interval: 4000,
    style,
    visibility,
  },
  imageCube: {
    layout: 'row2',
    cells: [
      { image: IMAGE, link: { kind: 'product', id: '12' } },
      { image: IMAGE, link: { kind: 'category', id: '3' } },
    ],
    height: 360,
    gap: 10,
    style,
    visibility,
  },
  hotspotImage: {
    image: IMAGE,
    hotspots: [
      { x: 0, y: 0, w: 50, h: 100, label: '左侧', link: { kind: 'product', id: '12' } },
      { x: 50, y: 0, w: 50, h: 100, label: '右侧', link: toRoute('couponCenter') },
    ],
    style,
    visibility,
  },
  titleBar: {
    title: '热卖推荐',
    subtitle: '大家都在买',
    align: 'left',
    moreText: '更多',
    moreLink: { kind: 'category', id: '3' },
    style,
    visibility,
  },
  productGrid: decorDocumentExample.blocks[1]?.props ?? {},
  productTabs: {
    tabs: [
      { title: '推荐', source: { mode: 'category', categoryId: '3', sort: 'sales', limit: 6 } },
      { title: '新品', source: { mode: 'manual', ids: ['12', '31'] } },
    ],
    layout: 'grid2',
    titleLines: 2,
    showMarketPrice: true,
    showTag: true,
    style,
    visibility,
  },
  richText: {
    html: '<p><strong>购物须知</strong></p><p>所有商品均为隐私包装发货。</p>',
    style,
    visibility,
  },
  spacer: { height: 24, line: 'solid', inset: true, style, visibility },
  userCard: { showStats: true, style, visibility },
  orderEntry: {
    title: '我的订单',
    items: [
      { key: 'unpaid', label: '待付款' },
      { key: 'unshipped', label: '待发货' },
      { key: 'unreceived', label: '待收货' },
      { key: 'unreviewed', label: '待评价' },
      { key: 'aftersale', label: '售后/退款' },
    ],
    style,
    visibility,
  },
  serviceGrid: {
    title: '我的服务',
    columns: 4,
    items: [
      { label: '优惠券', action: 'link', link: toRoute('myCoupons') },
      { label: '联系客服', action: 'contact' },
    ],
    style,
    visibility,
  },
  couponList: {
    title: '领券中心',
    showMore: true,
    source: { mode: 'manual', ids: ['1', '2'] },
    layout: 'scroll',
    style,
    visibility,
  },
  newcomerCoupon: {
    title: '新人专享',
    subtitle: '注册即得，下单立减',
    limit: 3,
    style,
    visibility,
  },
  groupbuyList: {
    title: '拼团',
    showMore: true,
    source: { mode: 'auto', limit: 3 },
    layout: 'list',
    style,
    visibility,
  },
  presaleList: {
    title: '预售',
    showMore: true,
    source: { mode: 'manual', ids: ['7'] },
    layout: 'list',
    showCountdown: true,
    style,
    visibility,
  },
  articleList: {
    title: '资讯',
    showMore: true,
    source: { mode: 'category', categoryId: '2', limit: 3 },
    layout: 'list',
    style,
    visibility,
  },
  video: {
    src: 'https://cdn.example.com/uploads/decor/intro.mp4',
    poster: IMAGE,
    ratio: '16:9',
    autoplay: false,
    muted: false,
    loop: false,
    style,
    visibility,
  },
  floatingContact: {
    label: '客服',
    side: 'right',
    bottom: 240,
    style,
    visibility,
  },
  followOfficialAccount: {
    style,
    visibility: { audience: 'all', platforms: ['wechat-mini'] },
  },
};
