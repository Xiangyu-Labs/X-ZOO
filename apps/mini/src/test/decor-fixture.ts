import type { ResponseOf } from '@shop/api-client';

type ResolvedPage = ResponseOf<'decor.pageHome'>;

const style = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
const visibility = { audience: 'all', platforms: [] } as const;

/**
 * A resolved DIY page as `GET /pages/home` answers it: a carousel linking to a product, a
 * product grid with its resolved products, and a block type this build does not know.
 */
export function resolvedPageFixture(overrides: Partial<ResolvedPage> = {}): ResolvedPage {
  return {
    id: '7',
    kind: 'home',
    revision: 3,
    preview: false,
    root: {
      props: {
        title: '示例首页',
        background: '#f5f5f5',
        shareEnabled: true,
        shareTitle: '首页好物',
      },
    },
    blocks: [
      {
        id: 'b-carousel',
        type: 'carousel',
        v: 1,
        props: {
          slides: [
            { image: '/uploads/banner.jpg', link: { kind: 'product', id: '12' }, alt: '新品上市' },
          ],
          height: 340,
          autoplay: true,
          interval: 4000,
          indicator: 'dots',
          indicatorColor: '#ffffff80',
          indicatorActiveColor: '#ffffff',
          style,
          visibility,
        },
        data: {},
      },
      {
        id: 'b-future',
        type: 'hologram',
        v: 1,
        props: { text: '未来的块' },
        data: {},
      },
      {
        id: 'b-grid',
        type: 'productGrid',
        v: 1,
        props: {
          source: { mode: 'category', categoryId: '3', sort: 'sales', limit: 4 },
          titleLines: 2,
          showMarketPrice: true,
          showTag: true,
          style,
          visibility,
        },
        data: {
          products: [
            { id: '12', title: '柔雾丝绒礼盒', image: '/uploads/p12.jpg', price: '129.00' },
            { id: '31', title: '温感按摩油', image: '/uploads/p31.jpg', price: '59.00' },
          ],
        },
      },
    ],
    personal: null,
    version: 'rev-3',
    resolvedAt: '2026-09-24T10:00:00+08:00',
    ...overrides,
  };
}
