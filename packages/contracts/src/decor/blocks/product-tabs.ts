import { z } from 'zod';

import { blockProps } from '../base';
import { productTabSlot } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { need, productSource, type DataNeed } from '../sources';
import { productDisplay } from './product-grid';

/**
 * 商品选项卡: 2–5 tabs over one product list, each tab with its own source.
 *
 * **Every tab's products come with the page.** The resolver answers a
 * block's needs in the page response and has no per-block endpoint to fetch
 * a tab later, so the block asks for one slot per tab (`tab0`, `tab1`, …),
 * each capped by its source's own limit (at most 20). Switching tabs is then
 * instant and offline. A lazy per-tab fetch would need a public "resolve one
 * source" route — a later addition if tabs ever grow heavy.
 */
export const productTab = z.object({
  title: z
    .string()
    .trim()
    .min(1, '请填写选项卡名称')
    .max(6)
    .meta(ui({ label: '名称' })),
  source: productSource
    .default({ mode: 'manual', ids: [] })
    .meta(ui({ label: '商品来源', field: 'productSource' })),
});
export type ProductTab = z.infer<typeof productTab>;

export const productTabsProps = blockProps({
  tabs: z
    .array(productTab)
    .min(2, '至少两个选项卡')
    .max(5)
    .default([
      { title: '推荐', source: { mode: 'manual', ids: [] } },
      { title: '新品', source: { mode: 'manual', ids: [] } },
    ])
    .meta(ui({ label: '选项卡', field: 'array', itemLabel: 'title', group: '内容' })),
  ...productDisplay,
});
export type ProductTabsProps = z.infer<typeof productTabsProps>;

export const productTabsBlock = defineBlock({
  type: 'productTabs',
  v: 1,
  props: productTabsProps,
  meta: { label: '商品选项卡', pages: ['home', 'custom'] },
  data: (props) =>
    Object.fromEntries(
      props.tabs.map((tab, index): [string, DataNeed] => [
        productTabSlot(index),
        need.products(tab.source),
      ]),
    ),
});
