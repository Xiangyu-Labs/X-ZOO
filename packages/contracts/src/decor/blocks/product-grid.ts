import { z } from 'zod';

import { blockProps } from '../base';
import { PRODUCT_LAYOUTS, type ProductLayout } from '../constants';
import { ui } from '../meta';
import { defineBlock, type BlockMigration } from '../registry';
import { need, productSource } from '../sources';

/**
 * The display switches every product list shares (商品列表, 商品选项卡). The
 * card itself is one component on the storefront; these only choose what it
 * shows.
 */
export const productDisplay = {
  layout: z
    .enum(Object.keys(PRODUCT_LAYOUTS) as [ProductLayout, ...ProductLayout[]])
    .default('grid2')
    .meta(ui({ label: '列表样式', options: PRODUCT_LAYOUTS, group: '展示' })),
  titleLines: z
    .union([z.literal(1), z.literal(2)])
    .default(2)
    .meta(
      ui({ label: '标题行数', field: 'radio', options: { 1: '一行', 2: '两行' }, group: '展示' }),
    ),
  showMarketPrice: z
    .boolean()
    .default(true)
    .meta(ui({ label: '显示划线价', group: '展示' })),
  showTag: z
    .boolean()
    .default(true)
    .meta(ui({ label: '显示角标', group: '展示' })),
};

/**
 * 商品列表: product cards from a declarative source, as a two- or
 * three-column grid, a one-column list or a horizontal scroller.
 *
 * The type keeps its first name, `productGrid`, because stored documents
 * name it; only the label changed.
 *
 * - v1: two columns only.
 * - v2: `layout`. A v1 block becomes `grid2`, which is exactly how it looked.
 */
export const productGridProps = blockProps({
  source: productSource
    .default({ mode: 'manual', ids: [] })
    .meta(ui({ label: '商品来源', field: 'productSource', group: '内容' })),
  ...productDisplay,
});

export type ProductGridProps = z.infer<typeof productGridProps>;

/** v1 → v2: add `layout`; everything else is unchanged. */
export const productGridV1ToV2: BlockMigration = (props) => ({ ...props, layout: 'grid2' });

export const productGridBlock = defineBlock({
  type: 'productGrid',
  v: 2,
  props: productGridProps,
  migrate: { 1: productGridV1ToV2 },
  meta: { label: '商品列表', pages: ['home', 'custom', 'user_center'] },
  data: (props) => ({ products: need.products(props.source) }),
});
