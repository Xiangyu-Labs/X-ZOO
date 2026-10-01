import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import { adminProductListItemExample } from '@shop/contracts/catalog/schemas';
import { articleListPublic } from '@shop/contracts/cms/cms.storefront.contract';
import { articleListItemExample } from '@shop/contracts/cms/schemas';
import {
  couponClaimableList,
  couponNewUserList,
} from '@shop/contracts/coupon/coupon.storefront.contract';
import { claimableCouponExample } from '@shop/contracts/coupon/schemas';
import { groupbuyList } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import { groupbuyCardExample } from '@shop/contracts/groupbuy/schemas';
import { presaleList } from '@shop/contracts/presale/presale.storefront.contract';
import { presaleCardExample } from '@shop/contracts/presale/schemas';
import { DECOR_BLOCK_DEFINITIONS, decorBlocks } from '@shop/contracts/decor/all-blocks';
import { blockProps } from '@shop/contracts/decor/base';
import { createBlockRegistry, defineBlock } from '@shop/contracts/decor/registry';
import type { DataNeed } from '@shop/contracts/decor/sources';
import {
  fixtureCarousel,
  fixtureImageCube,
  fixtureProductGrid,
  resolveFixtureProducts,
} from '@shop/storefront-blocks/fixtures';
import { screen } from '@testing-library/react';
import { version, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { on, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';
import {
  DecorCanvasDataProvider,
  createAdminCanvasData,
  previewProducts,
  type DecorCanvasData,
} from './canvas-data';
import { buildDecorConfig } from './config';
import { UNKNOWN_BLOCK } from './document';
import { SEMANTIC_FIELD_KINDS, type CustomFieldRenderers } from './zod-to-puck';

/**
 * The editor canvas renders the storefront's own blocks — the prebuilt
 * `@shop/storefront-blocks/admin` bundle, Taro components swapped for the DOM
 * shim — on the admin's React 19. (The package's own tests run the same
 * blocks on React 18.)
 */

const noField = (() => null) as never;
const custom = {
  ...Object.fromEntries(SEMANTIC_FIELD_KINDS.map((kind) => [kind, noField])),
  multiChoice: noField,
} as unknown as CustomFieldRenderers;

const config = buildDecorConfig({ kind: 'custom', custom });

function renderBlock(type: string, props: Record<string, unknown>): ReactElement {
  const component = config.components[type];
  if (!component) throw new Error(`no component ${type}`);
  const Render = component.render as (props: Record<string, unknown>) => ReactElement;
  return <Render id={`${type}-1`} puck={{ isEditing: true }} editMode {...props} />;
}

const fixtureData: DecorCanvasData = {
  resolve: async (need: DataNeed) =>
    need.kind === 'products' ? resolveFixtureProducts(need.source) : null,
};

describe('decor canvas', () => {
  it('runs on the admin React', () => {
    expect(version.split('.')[0]).toBe('19');
  });

  it('draws a carousel through the DOM shim, one aspectFill image per slide', () => {
    const { container } = renderAdmin(renderBlock('carousel', fixtureCarousel));
    expect(container.querySelector('[data-block="carousel"]')).not.toBeNull();
    expect(container.querySelectorAll('.sbd-swiper-item')).toHaveLength(3);
    expect(container.querySelectorAll('.sbd-image--aspectFill')).toHaveLength(3);
    expect(screen.getByAltText('秋季上新')).toBeInTheDocument();
  });

  it('draws a product grid from the data its declared needs resolve to', async () => {
    renderAdmin(
      <DecorCanvasDataProvider value={fixtureData}>
        {renderBlock('productGrid', fixtureProductGrid)}
      </DecorCanvasDataProvider>,
    );
    expect(await screen.findByText('云南古树普洱茶饼 357g')).toBeInTheDocument();
    expect(screen.getByText('新品')).toBeInTheDocument();
  });

  it('draws an image cube in its layout', () => {
    const { container } = renderAdmin(renderBlock('imageCube', fixtureImageCube));
    expect(container.querySelector('[data-block="imageCube"]')).not.toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(3);
  });

  it('shows a notice instead of crashing on props it cannot draw', () => {
    renderAdmin(renderBlock('imageCube', { ...fixtureImageCube, cells: null, style: null }));
    expect(screen.getByText('图片魔方：当前配置无法预览')).toBeInTheDocument();
  });

  it('shows a placeholder for a registered block the canvas has no component for yet', () => {
    const video = defineBlock({
      type: 'videoPlayer',
      v: 1,
      props: blockProps({}),
      meta: { label: '视频', pages: ['custom'] },
    });
    const withVideo = buildDecorConfig({
      kind: 'custom',
      custom,
      registry: createBlockRegistry([...DECOR_BLOCK_DEFINITIONS, video]),
    });
    const Render = withVideo.components.videoPlayer!.render as (
      p: Record<string, unknown>,
    ) => ReactElement;
    renderAdmin(<Render id="v1" puck={{ isEditing: true }} />);
    expect(screen.getByText(/画布暂无此组件的预览/)).toBeInTheDocument();
  });

  it('shows a notice for a block it cannot edit', () => {
    renderAdmin(renderBlock(UNKNOWN_BLOCK, { reason: '当前后台不认识组件「videoPlayer」' }));
    expect(screen.getByText(/不认识组件「videoPlayer」/)).toBeInTheDocument();
    expect(screen.getByText(/无法发布/)).toBeInTheDocument();
  });
});

describe('decor config', () => {
  it('offers only the blocks allowed on the page kind, and hides the rest', () => {
    const home = buildDecorConfig({ kind: 'home', custom });
    const onHome = decorBlocks
      .list()
      .filter((definition) => definition.meta.pages.includes('home'))
      .map((definition) => definition.type);
    expect(home.categories?.blocks?.components).toEqual(onHome);
    expect(onHome).toEqual(expect.arrayContaining(['carousel', 'imageCube', 'productGrid']));
    expect(onHome).not.toContain('userCard');
    expect(home.categories?.other).toEqual({ visible: false });
    // Still registered: a stored page may hold them.
    expect(Object.keys(home.components)).toContain('userCard');
    const me = buildDecorConfig({ kind: 'user_center', custom });
    expect(me.categories?.blocks?.components).toEqual(
      expect.arrayContaining(['userCard', 'orderEntry', 'serviceGrid']),
    );
  });

  it('lets an uneditable block move and go, but not be copied or edited', () => {
    expect(config.components[UNKNOWN_BLOCK]?.permissions).toEqual({
      duplicate: false,
      edit: false,
    });
  });
});

describe('admin canvas data', () => {
  const row = { ...adminProductListItemExample, id: '7', name: '丝绒礼盒', stock: 3 };

  it('previews a manual list in its order, on-shelf only, through the ids filter', async () => {
    const calls = stubRoutes([
      on(catalogAdminProductList, {
        items: [{ ...row, id: '9', name: '乙' }, row],
        total: 2,
        page: 1,
        pageSize: 2,
      }),
    ]);
    const products = await previewProducts({ mode: 'manual', ids: ['7', '9'] });
    expect(products.map((product) => product.id)).toEqual(['7', '9']);
    expect(calls[0]?.url).toContain('tab=on_shelf');
    expect(calls[0]?.url).toContain(`ids=${encodeURIComponent('7,9')}`);
  });

  it('previews a rule with stock only, at most limit, in the chosen order', async () => {
    const calls = stubRoutes([
      on(catalogAdminProductList, {
        items: [
          { ...row, id: '1', stock: 0 },
          { ...row, id: '2' },
          { ...row, id: '3' },
        ],
        total: 3,
        page: 1,
        pageSize: 22,
      }),
    ]);
    const products = await previewProducts({
      mode: 'category',
      categoryId: '5',
      sort: 'sales',
      limit: 1,
    });
    expect(products.map((product) => product.id)).toEqual(['2']);
    expect(calls[0]?.url).toContain('categoryId=5');
    expect(calls[0]?.url).toContain('sortBy=sales');
  });

  it('previews nothing for a rule not set up yet, or a manual pick with nothing picked', async () => {
    const calls = stubRoutes([]);
    const data = createAdminCanvasData();
    await expect(
      data.resolve({
        kind: 'products',
        source: { mode: 'category', categoryId: '', sort: 'default', limit: 6 },
      }),
    ).resolves.toEqual([]);
    await expect(
      data.resolve({ kind: 'coupons', source: { mode: 'manual', ids: [] } }),
    ).resolves.toEqual([]);
    await expect(
      data.resolve({ kind: 'groupbuys', source: { mode: 'manual', ids: [] } }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('previews coupons through the storefront list, without any caller state', async () => {
    const calls = stubRoutes([
      on(couponClaimableList, {
        items: [{ ...claimableCouponExample, templateId: '9' }, claimableCouponExample],
        total: 2,
        page: 1,
        pageSize: 2,
      }),
    ]);
    const data = createAdminCanvasData();
    const coupons = (await data.resolve({
      kind: 'coupons',
      source: { mode: 'manual', ids: ['9', claimableCouponExample.templateId] },
    })) as Record<string, unknown>[];
    expect(coupons.map((coupon) => coupon.templateId)).toEqual([
      '9',
      claimableCouponExample.templateId,
    ]);
    expect(coupons[0]).not.toHaveProperty('canClaim');
    expect(coupons[0]).not.toHaveProperty('claimedCount');
    expect(calls[0]?.url).toContain(
      `ids=${encodeURIComponent(`9,${claimableCouponExample.templateId}`)}`,
    );
  });

  it('previews at most limit 新人券', async () => {
    stubRoutes([
      on(couponNewUserList, {
        items: [
          { ...claimableCouponExample, templateId: '1', canClaim: null, claimedCount: null },
          { ...claimableCouponExample, templateId: '2', canClaim: null, claimedCount: null },
        ],
      }),
    ]);
    const coupons = (await createAdminCanvasData().resolve({
      kind: 'newUserCoupons',
      limit: 1,
    })) as { templateId: string }[];
    expect(coupons.map((coupon) => coupon.templateId)).toEqual(['1']);
  });

  it('previews picked 拼团 and 预售 through the ids filter, and the rule by limit', async () => {
    const calls = stubRoutes([
      on(groupbuyList, { items: [groupbuyCardExample], total: 1, page: 1, pageSize: 2 }),
      on(presaleList, { items: [presaleCardExample], total: 1, page: 1, pageSize: 4 }),
    ]);
    const data = createAdminCanvasData();
    await expect(
      data.resolve({ kind: 'groupbuys', source: { mode: 'manual', ids: ['1', 'x', '8'] } }),
    ).resolves.toEqual([groupbuyCardExample]);
    await expect(
      data.resolve({ kind: 'presales', source: { mode: 'auto', limit: 4 } }),
    ).resolves.toEqual([presaleCardExample]);
    expect(calls[0]?.url).toContain(`ids=${encodeURIComponent('1,8')}`);
    expect(calls[0]?.url).toContain('pageSize=2');
    expect(calls[1]?.url).toContain('pageSize=4');
    expect(calls[1]?.url).not.toContain('ids=');
  });

  it('previews a category’s published articles as the resolver summarises them', async () => {
    const calls = stubRoutes([
      on(articleListPublic, { items: [articleListItemExample], total: 1, page: 1, pageSize: 3 }),
    ]);
    const articles = (await createAdminCanvasData().resolve({
      kind: 'articles',
      source: { mode: 'category', categoryId: '3', limit: 3 },
    })) as Record<string, unknown>[];
    expect(Object.keys(articles[0]!).sort()).toEqual(
      [
        'author',
        'categoryTitle',
        'coverImageUrl',
        'id',
        'publishedAt',
        'summary',
        'title',
        'views',
      ].sort(),
    );
    expect(calls[0]?.url).toContain('categoryId=3');
  });
});
