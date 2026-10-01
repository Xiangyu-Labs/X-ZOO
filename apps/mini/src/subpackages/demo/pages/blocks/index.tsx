import { View } from '@tarojs/components';
import { useRouter } from '@tarojs/taro';
import {
  BlockList,
  type BlockHost,
  type BlockIntent,
  type RenderedBlock,
} from '@shop/storefront-blocks';
import {
  fixtureArticleList,
  fixtureArticles,
  fixtureCarousel,
  fixtureCouponList,
  fixtureCoupons,
  fixtureFloatingContact,
  fixtureFollowOfficialAccount,
  fixtureGroupbuyList,
  fixtureGroupbuys,
  fixtureHotspotImage,
  fixtureImageCube,
  fixtureNavGrid,
  fixtureNewcomerCoupon,
  fixtureNewUserCoupons,
  fixtureNotice,
  fixtureOrderEntry,
  fixturePersonalG2,
  fixturePresaleList,
  fixturePresales,
  fixtureProductGrid,
  fixtureProductTabs,
  fixtureProductTabsData,
  fixtureRichText,
  fixtureSearchBar,
  fixtureServerNow,
  fixtureServiceGrid,
  fixtureSpacer,
  fixtureTitleBar,
  fixtureUserCard,
  fixtureVideo,
  resolveFixtureProducts,
} from '@shop/storefront-blocks/fixtures';
import { useDecorRenderIntent } from '@/features/decor/decor-host';
import { showToast } from '@/platform';

/**
 * Dev-only (spike S3, batches G1 and G2): every DIY v2 block from
 * `@shop/storefront-blocks`, on the same fixtures and in the same order as the
 * admin editor's canvas (`/admin/dev/decor-spike`), for the pixel comparison in
 * `packages/storefront-blocks/fidelity`. The background is the page document's
 * default (`#f5f5f5`), as in the canvas.
 *
 * Two modes:
 *
 * - `?canvas=1` draws what the canvas draws, for the comparison: a guest, the
 *   video as its poster, 悬浮客服 in the flow, the 关注公众号 explanation, the
 *   预售 end time instead of a countdown.
 * - Without it, the live look: a signed-in shopper's coupon states and held
 *   新人券, the countdown against the fixture server time, the floating button,
 *   and the host wrappers a real page adds (`useDecorRenderIntent`, the same
 *   as 首页's: WeChat's contact button per the shop's 客服 setting, and the
 *   关注公众号 bar in the mini-program).
 */
const BLOCKS: RenderedBlock[] = [
  { id: 'search-bar-1', type: 'searchBar', props: fixtureSearchBar },
  { id: 'carousel-1', type: 'carousel', props: fixtureCarousel },
  { id: 'nav-grid-1', type: 'navGrid', props: fixtureNavGrid },
  { id: 'notice-1', type: 'notice', props: fixtureNotice },
  { id: 'title-bar-1', type: 'titleBar', props: fixtureTitleBar },
  { id: 'product-grid-1', type: 'productGrid', props: fixtureProductGrid },
  { id: 'image-cube-1', type: 'imageCube', props: fixtureImageCube },
  { id: 'hotspot-image-1', type: 'hotspotImage', props: fixtureHotspotImage },
  { id: 'product-tabs-1', type: 'productTabs', props: fixtureProductTabs },
  { id: 'spacer-1', type: 'spacer', props: fixtureSpacer },
  { id: 'rich-text-1', type: 'richText', props: fixtureRichText },
  { id: 'user-card-1', type: 'userCard', props: fixtureUserCard },
  { id: 'order-entry-1', type: 'orderEntry', props: fixtureOrderEntry },
  { id: 'service-grid-1', type: 'serviceGrid', props: fixtureServiceGrid },
  { id: 'coupon-list-1', type: 'couponList', props: fixtureCouponList },
  { id: 'newcomer-coupon-1', type: 'newcomerCoupon', props: fixtureNewcomerCoupon },
  { id: 'groupbuy-list-1', type: 'groupbuyList', props: fixtureGroupbuyList },
  { id: 'presale-list-1', type: 'presaleList', props: fixturePresaleList },
  { id: 'article-list-1', type: 'articleList', props: fixtureArticleList },
  { id: 'video-1', type: 'video', props: fixtureVideo },
  { id: 'floating-contact-1', type: 'floatingContact', props: fixtureFloatingContact },
  {
    id: 'follow-official-account-1',
    type: 'followOfficialAccount',
    props: fixtureFollowOfficialAccount,
  },
];

const DATA = {
  'product-grid-1': { products: resolveFixtureProducts(fixtureProductGrid.source) },
  'product-tabs-1': fixtureProductTabsData,
  'coupon-list-1': { coupons: fixtureCoupons },
  'newcomer-coupon-1': { coupons: fixtureNewUserCoupons },
  'groupbuy-list-1': { campaigns: fixtureGroupbuys },
  'presale-list-1': { campaigns: fixturePresales },
  'article-list-1': { articles: fixtureArticles },
};

const PERSONAL = {
  'coupon-list-1': fixturePersonalG2.couponList,
  'newcomer-coupon-1': fixturePersonalG2.newcomerCoupon,
};

/** The demo only names the intent a real page would handle. */
function onIntent(intent: BlockIntent): void {
  showToast(`intent: ${intent.kind}`);
}

export default function BlocksDemo() {
  const canvas = useRouter().params.canvas === '1';
  const renderIntent = useDecorRenderIntent('route:demo');
  const host: BlockHost = canvas ? { canvas: true } : { serverNow: fixtureServerNow };
  return (
    <View style={{ background: '#f5f5f5', minHeight: '100vh' }}>
      <BlockList
        blocks={BLOCKS}
        data={DATA}
        personal={canvas ? null : PERSONAL}
        host={host}
        onIntent={onIntent}
        {...(canvas ? {} : { renderIntent })}
      />
    </View>
  );
}
