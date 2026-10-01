import type { StoredDocument } from '@shop/contracts/decor/document';
import type { LinkTarget } from '@shop/contracts/decor/link';

/**
 * The template documents. Quiet by design: a warm off-white page, rounded
 * cards with even gutters, short plain headings, no loud colour and no
 * promotional shouting. The pictures and the products do the talking, and the
 * operator supplies both.
 *
 * Image slots are left empty on purpose (`image: ''`, `icon: ''`). A template
 * cannot ship the shop's photography, and a stock picture that slips through
 * to a shopper is worse than none: an empty slot is a `请选择图片` issue,
 * listed under the toolbar with 定位, and the page cannot be published until
 * each one is filled. The canvas draws an empty slot as a placeholder
 * (`../canvas-images.ts`). Product lists start as an empty hand-picked list
 * for the same reason: a category or label rule needs this shop's ids.
 *
 * Every block is written out in full (defaults included) so what the operator
 * sees in the inspector is exactly what is stored; `templates.test.ts` holds
 * each document to `checkDocument` for its page kind.
 */

const everyone = { audience: 'all', platforms: [] } as const;

type Spacing = 'none' | 'sm' | 'md' | 'lg';
type Radius = 'none' | 'sm' | 'lg';

function style(marginY: Spacing, paddingX: Spacing, radius: Radius) {
  return { marginY, paddingX, radius };
}

function route(name: string, params: Record<string, string> = {}): LinkTarget {
  return { kind: 'route', to: { route: name, params } } as LinkTarget;
}

const WARM_WHITE = '#f7f5f2';

/** A rounded card inside the page gutter: most blocks sit like this. */
const card = style('sm', 'sm', 'lg');

function heading(
  id: string,
  title: string,
  { more, align = 'left' }: { more?: LinkTarget; align?: 'left' | 'center' } = {},
) {
  return {
    id,
    type: 'titleBar',
    v: 1,
    props: {
      title,
      subtitle: '',
      align,
      moreText: '更多',
      ...(more ? { moreLink: more } : {}),
      style: style('sm', 'sm', 'none'),
      visibility: everyone,
    },
  };
}

const productDisplay = { titleLines: 2, showMarketPrice: true, showTag: true } as const;

/**
 * 首页 · 简约: search, hero, five quick entries, one line of notice, the
 * coupons on offer, a feature cube, new arrivals as a scroller and the rest
 * under tabs.
 */
export const HOME_MODERN: StoredDocument = {
  schemaVersion: 2,
  root: {
    props: { title: '首页', background: WARM_WHITE, shareEnabled: true, shareTitle: '' },
  },
  blocks: [
    {
      id: 'home-search',
      type: 'searchBar',
      v: 1,
      props: {
        placeholder: '搜索商品',
        hotWords: [],
        shape: 'round',
        sticky: true,
        style: style('none', 'sm', 'none'),
        visibility: everyone,
      },
    },
    {
      id: 'home-hero',
      type: 'carousel',
      v: 1,
      props: {
        slides: [
          { image: '', alt: '新品上市', link: route('featured', { tab: 'new' }) },
          { image: '', alt: '本周精选', link: route('featured', { tab: 'best' }) },
          { image: '', alt: '领券中心', link: route('couponCenter') },
        ],
        height: 360,
        autoplay: true,
        interval: 4000,
        indicator: 'dots',
        indicatorColor: '#ffffff80',
        indicatorActiveColor: '#ffffff',
        style: card,
        visibility: everyone,
      },
    },
    {
      id: 'home-entries',
      type: 'navGrid',
      v: 1,
      props: {
        items: [
          { icon: '', label: '全部分类', link: route('category') },
          { icon: '', label: '新品', link: route('featured', { tab: 'new' }) },
          { icon: '', label: '热销', link: route('featured', { tab: 'hot' }) },
          { icon: '', label: '领券', link: route('couponCenter') },
          { icon: '', label: '拼团', link: route('groupbuyList') },
        ],
        columns: 5,
        rows: 1,
        paging: false,
        iconShape: 'circle',
        style: { ...card, background: '#ffffff' },
        visibility: everyone,
      },
    },
    {
      id: 'home-notice',
      type: 'notice',
      v: 1,
      props: {
        label: '公告',
        lines: [{ text: '所有订单均以隐私包装发出，外包装不显示商品信息' }],
        mode: 'scroll',
        interval: 5000,
        style: card,
        visibility: everyone,
      },
    },
    {
      // All claimable coupons, first three; the row hides itself when there are none.
      id: 'home-coupons',
      type: 'couponList',
      v: 1,
      props: {
        title: '领券中心',
        showMore: true,
        source: { mode: 'auto', limit: 3 },
        layout: 'scroll',
        style: card,
        visibility: everyone,
      },
    },
    {
      id: 'home-feature',
      type: 'imageCube',
      v: 1,
      props: {
        layout: 'left1right2',
        cells: [
          { image: '', link: route('featured', { tab: 'best' }) },
          { image: '', link: route('featured', { tab: 'new' }) },
          { image: '', link: route('couponCenter') },
        ],
        height: 340,
        gap: 12,
        style: card,
        visibility: everyone,
      },
    },
    heading('home-new-title', '新品上市', { more: route('featured', { tab: 'new' }) }),
    {
      id: 'home-new',
      type: 'productGrid',
      v: 2,
      props: {
        source: { mode: 'manual', ids: [] },
        layout: 'scroll',
        ...productDisplay,
        style: card,
        visibility: everyone,
      },
    },
    heading('home-more-title', '为你推荐'),
    {
      id: 'home-tabs',
      type: 'productTabs',
      v: 1,
      props: {
        tabs: [
          { title: '精选', source: { mode: 'manual', ids: [] } },
          { title: '新品', source: { mode: 'manual', ids: [] } },
          { title: '热销', source: { mode: 'manual', ids: [] } },
        ],
        layout: 'grid2',
        ...productDisplay,
        style: card,
        visibility: everyone,
      },
    },
  ],
};

/** 个人中心 · 简洁: the card, the orders, and the services in two quiet groups. */
export const USER_CENTER_CLEAN: StoredDocument = {
  schemaVersion: 2,
  root: {
    // Nobody shares their own account page.
    props: { title: '我的', background: WARM_WHITE, shareEnabled: false, shareTitle: '' },
  },
  blocks: [
    {
      id: 'me-card',
      type: 'userCard',
      v: 1,
      props: { showStats: true, style: style('none', 'none', 'none'), visibility: everyone },
    },
    {
      id: 'me-orders',
      type: 'orderEntry',
      v: 1,
      props: {
        title: '我的订单',
        items: [
          { key: 'unpaid', label: '待付款' },
          { key: 'unshipped', label: '待发货' },
          { key: 'unreceived', label: '待收货' },
          { key: 'unreviewed', label: '待评价' },
          { key: 'aftersale', label: '售后/退款' },
        ],
        style: card,
        visibility: everyone,
      },
    },
    {
      id: 'me-benefits',
      type: 'serviceGrid',
      v: 1,
      props: {
        title: '优惠与记录',
        columns: 4,
        items: [
          { label: '优惠券', action: 'link', link: route('myCoupons') },
          { label: '领券中心', action: 'link', link: route('couponCenter') },
          { label: '我的收藏', action: 'link', link: route('favorites') },
          { label: '浏览记录', action: 'link', link: route('history') },
        ],
        style: card,
        visibility: everyone,
      },
    },
    {
      id: 'me-account',
      type: 'serviceGrid',
      v: 1,
      props: {
        title: '账户与服务',
        columns: 4,
        items: [
          { label: '收货地址', action: 'link', link: route('addresses') },
          { label: '我的评价', action: 'link', link: route('myReviews') },
          { label: '发票管理', action: 'link', link: route('invoices') },
          { label: '消息中心', action: 'link', link: route('messages') },
          { label: '我的拼团', action: 'link', link: route('myGroupbuys') },
          { label: '联系客服', action: 'contact' },
          { label: '设置', action: 'link', link: route('settings') },
        ],
        style: card,
        visibility: everyone,
      },
    },
  ],
};

/**
 * 微页面 · 专题: one still hero, a few lines about the event, a feature and
 * two tiles, then the products.
 */
export const CUSTOM_CAMPAIGN: StoredDocument = {
  schemaVersion: 2,
  root: {
    props: { title: '专题活动', background: '#ffffff', shareEnabled: true, shareTitle: '' },
  },
  blocks: [
    {
      id: 'topic-hero',
      type: 'carousel',
      v: 1,
      props: {
        slides: [{ image: '', alt: '专题主图' }],
        height: 480,
        autoplay: false,
        interval: 3000,
        indicator: 'none',
        indicatorColor: '#ffffff80',
        indicatorActiveColor: '#ffffff',
        style: style('none', 'none', 'none'),
        visibility: everyone,
      },
    },
    {
      id: 'topic-intro',
      type: 'richText',
      v: 1,
      props: {
        html: '<h3>活动说明</h3><p>在这里写活动时间、参与方式和优惠规则。</p>',
        style: style('md', 'md', 'none'),
        visibility: everyone,
      },
    },
    {
      id: 'topic-rule',
      type: 'spacer',
      v: 1,
      props: {
        height: 24,
        line: 'solid',
        lineColor: '#ebe7e1',
        inset: true,
        style: style('none', 'none', 'none'),
        visibility: everyone,
      },
    },
    {
      id: 'topic-features',
      type: 'imageCube',
      v: 1,
      props: {
        layout: 'top1bottom2',
        cells: [
          { image: '', link: route('featured', { tab: 'best' }) },
          { image: '', link: route('couponCenter') },
          { image: '', link: route('featured', { tab: 'new' }) },
        ],
        height: 520,
        gap: 12,
        style: style('md', 'sm', 'lg'),
        visibility: everyone,
      },
    },
    heading('topic-products-title', '活动商品', { align: 'center' }),
    {
      id: 'topic-products',
      type: 'productGrid',
      v: 2,
      props: {
        source: { mode: 'manual', ids: [] },
        layout: 'grid2',
        titleLines: 1,
        showMarketPrice: true,
        showTag: false,
        style: card,
        visibility: everyone,
      },
    },
  ],
};
