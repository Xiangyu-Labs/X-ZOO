import {
  fixtureCouponList,
  fixtureCoupons,
  fixtureFloatingContact,
  fixtureFollowOfficialAccount,
  fixtureHotspotImage,
  fixturePresaleList,
  fixturePresales,
  fixtureVideo,
  fixtureNavGrid,
  fixtureNotice,
  fixtureOrderEntry,
  fixtureProductTabs,
  fixtureRichText,
  fixtureSearchBar,
  fixtureServiceGrid,
  fixtureSpacer,
  fixtureTitleBar,
  fixtureUserCard,
  resolveFixtureProducts,
} from '@shop/storefront-blocks/fixtures';
import type { DataNeed } from '@shop/contracts/decor/sources';
import { BLOCKS, decorBlocks, type BlockType } from '@shop/storefront-blocks/schema';
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderAdmin } from '@/test/render';

import { DecorCanvasDataProvider, type DecorCanvasData } from './canvas-data';
import { buildDecorConfig, newBlockProps } from './config';
import { SEMANTIC_FIELD_KINDS, zodToPuckFields, type CustomFieldRenderers } from './zod-to-puck';

/** The batch-1 blocks in the editor canvas (React 19, the prebuilt admin bundle). */

const noField = (() => null) as never;
const custom = {
  ...Object.fromEntries(SEMANTIC_FIELD_KINDS.map((kind) => [kind, noField])),
  multiChoice: noField,
} as unknown as CustomFieldRenderers;

const config = buildDecorConfig({ kind: 'custom', custom });

const canvasData: DecorCanvasData = {
  resolve: async (need: DataNeed) =>
    need.kind === 'products' ? resolveFixtureProducts(need.source) : null,
};

function renderBlock(type: string, props: unknown): ReactElement {
  const component = config.components[type];
  if (!component) throw new Error(`no component ${type}`);
  const Render = component.render as (props: Record<string, unknown>) => ReactElement;
  return <Render id={`${type}-1`} puck={{ isEditing: true }} editMode {...(props as object)} />;
}

describe('the editor palette', () => {
  it('offers every registered block', () => {
    expect(
      Object.keys(config.components)
        .filter((type) => decorBlocks.get(type))
        .sort(),
    ).toEqual([...decorBlocks.types].sort());
  });

  it('gives the rich-text and hotspot props their own controls', () => {
    const rich = zodToPuckFields(BLOCKS.richText.props, custom);
    expect(rich.html).toMatchObject({ type: 'custom', label: '内容', render: custom.richText });
    const hot = zodToPuckFields(BLOCKS.hotspotImage.props, custom);
    expect(hot.hotspots).toMatchObject({ type: 'custom', label: '热区', render: custom.hotspots });
  });

  it('starts every block with props its schema accepts once the pictures are picked', () => {
    for (const type of Object.keys(BLOCKS) as BlockType[]) {
      const props = newBlockProps(decorBlocks.get(type)!);
      const result = BLOCKS[type].props.safeParse(props);
      // Only what the operator has to supply — a picture, an entry's text or link —
      // may keep a new block invalid; never a missing array item or a bad default.
      const blocking = result.success
        ? []
        : result.error.issues.filter(
            (issue) => !/^(image|icon|label|text|link|src)$/.test(String(issue.path.at(-1) ?? '')),
          );
      expect(blocking, type).toEqual([]);
    }
  });
});

describe('the batch-1 blocks on the canvas', () => {
  it('draws the content blocks through the DOM shim', () => {
    const blocks: [string, unknown][] = [
      ['searchBar', fixtureSearchBar],
      ['navGrid', fixtureNavGrid],
      ['notice', fixtureNotice],
      ['hotspotImage', fixtureHotspotImage],
      ['titleBar', fixtureTitleBar],
      ['richText', fixtureRichText],
      ['spacer', fixtureSpacer],
    ];
    for (const [type, props] of blocks) {
      const { container, unmount } = renderAdmin(renderBlock(type, props));
      expect(container.querySelector(`[data-block="${type}"]`), type).not.toBeNull();
      unmount();
    }
  });

  it('fills each 商品选项卡 tab from the canvas products', async () => {
    renderAdmin(
      <DecorCanvasDataProvider value={canvasData}>
        {renderBlock('productTabs', fixtureProductTabs)}
      </DecorCanvasDataProvider>,
    );
    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(await screen.findByText('厨房收纳三件套')).toBeInTheDocument();
  });

  it('draws the 个人中心 blocks as a guest sees them, with no shopper state', () => {
    renderAdmin(
      <>
        {renderBlock('userCard', fixtureUserCard)}
        {renderBlock('orderEntry', fixtureOrderEntry)}
        {renderBlock('serviceGrid', fixtureServiceGrid)}
      </>,
    );
    expect(screen.getByText('登录 / 注册')).toBeInTheDocument();
    expect(screen.getByText('待付款')).toBeInTheDocument();
    expect(screen.getByText('联系客服')).toBeInTheDocument();
  });

  it('never lets rich text out of the allow-list on the canvas either', () => {
    const { container } = renderAdmin(
      renderBlock('richText', {
        ...fixtureRichText,
        html: '<p>ok</p><script>window.pwned = 1</script><img src="x" onerror="alert(1)">',
      }),
    );
    expect(container.querySelector('script, img')).toBeNull();
    expect(container.querySelector('[data-block="richText"]')?.textContent).toBe('ok');
  });
});

describe('the batch-2 blocks on the canvas', () => {
  const g2Data: DecorCanvasData = {
    resolve: async (need: DataNeed) => {
      if (need.kind === 'coupons') return fixtureCoupons;
      if (need.kind === 'presales') return fixturePresales;
      return null;
    },
  };

  it('draws the previewed coupons, as a guest sees them: every ticket 领取', async () => {
    const { container } = renderAdmin(
      <DecorCanvasDataProvider value={g2Data}>
        {renderBlock('couponList', fixtureCouponList)}
      </DecorCanvasDataProvider>,
    );
    expect(await screen.findByText('全场通用券')).toBeInTheDocument();
    const actions = [...container.querySelectorAll('[data-coupon]')].map((node) =>
      node.getAttribute('data-action'),
    );
    expect(actions).toEqual(['claim', 'claim', 'claim']);
  });

  it('says a list with nothing to preview is hidden in the store, instead of vanishing', () => {
    renderAdmin(renderBlock('couponList', fixtureCouponList));
    expect(screen.getByText('暂无可领取的优惠券，商城中不显示此组件')).toBeInTheDocument();
  });

  it('shows a presale’s end time, not a countdown against the editor’s clock', async () => {
    const { container } = renderAdmin(
      <DecorCanvasDataProvider value={g2Data}>
        {renderBlock('presaleList', fixturePresaleList)}
      </DecorCanvasDataProvider>,
    );
    await screen.findByText(fixturePresales[0]!.title);
    expect(container.textContent).not.toMatch(/\d+天 \d{2}:\d{2}:\d{2}/);
  });

  it('draws a video as its poster, never a playing player', () => {
    const { container } = renderAdmin(renderBlock('video', fixtureVideo));
    expect(container.querySelector('[data-block="video"] [data-still]')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('keeps the floating button in the flow, where it can be selected, and says where it floats', () => {
    const { container } = renderAdmin(renderBlock('floatingContact', fixtureFloatingContact));
    expect(container.querySelector('[data-block="floatingContact"]')).not.toBeNull();
    expect(screen.getByText('悬浮在页面右侧，距底部 240')).toBeInTheDocument();
  });

  it('explains 关注公众号 instead of drawing what only WeChat can', () => {
    renderAdmin(renderBlock('followOfficialAccount', fixtureFollowOfficialAccount));
    expect(screen.getByText('关注公众号')).toBeInTheDocument();
    expect(screen.getByText(/从扫码/)).toBeInTheDocument();
  });
});
