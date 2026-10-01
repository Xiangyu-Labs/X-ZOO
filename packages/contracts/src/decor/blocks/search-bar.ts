import { z } from 'zod';

import { blockProps } from '../base';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * 搜索框: a tappable search field. It is not an input — a tap opens the
 * `search` route, where the shopper types; a hot word opens it with that
 * keyword. `sticky` keeps it at the top of the page while scrolling.
 */
export const searchBarHotWord = z.object({
  word: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .meta(ui({ label: '热词' })),
});
export type SearchBarHotWord = z.infer<typeof searchBarHotWord>;

export const searchBarProps = blockProps({
  placeholder: z
    .string()
    .max(20)
    .default('搜索商品')
    .meta(ui({ label: '提示文字', group: '内容' })),
  hotWords: z
    .array(searchBarHotWord)
    .max(8)
    .default([])
    .meta(ui({ label: '热门搜索词', field: 'array', itemLabel: 'word', group: '内容' })),
  shape: z
    .enum(['round', 'square'])
    .default('round')
    .meta(
      ui({
        label: '搜索框形状',
        field: 'radio',
        options: { round: '圆角', square: '方角' },
        group: '展示',
      }),
    ),
  sticky: z
    .boolean()
    .default(false)
    .meta(ui({ label: '滚动时固定在顶部', group: '展示' })),
});
export type SearchBarProps = z.infer<typeof searchBarProps>;

export const searchBarBlock = defineBlock({
  type: 'searchBar',
  v: 1,
  props: searchBarProps,
  meta: { label: '搜索框', pages: ['home', 'custom'], maxPerPage: 1 },
});
