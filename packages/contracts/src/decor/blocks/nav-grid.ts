import { z } from 'zod';

import { blockProps, imageUrl } from '../base';
import { linkTarget } from '../link';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * 导航宫格: icon + label entries, 4 or 5 to a row. With `paging`, entries
 * beyond `rows` rows go to further pages the shopper swipes to; without it,
 * every entry shows and the grid simply grows.
 */
export const navGridItem = z.object({
  icon: imageUrl.meta(ui({ label: '图标', field: 'image' })),
  label: z
    .string()
    .trim()
    .min(1, '请填写文字')
    .max(6)
    .meta(ui({ label: '文字' })),
  link: linkTarget.optional().meta(ui({ label: '跳转链接', field: 'link' })),
});
export type NavGridItem = z.infer<typeof navGridItem>;

export const navGridProps = blockProps({
  items: z
    .array(navGridItem)
    .min(1, '至少一个入口')
    .max(20)
    .meta(ui({ label: '入口', field: 'array', itemLabel: 'label', group: '内容' })),
  columns: z
    .union([z.literal(4), z.literal(5)])
    .default(5)
    .meta(
      ui({ label: '每行个数', field: 'radio', options: { 4: '4 个', 5: '5 个' }, group: '布局' }),
    ),
  rows: z
    .union([z.literal(1), z.literal(2)])
    .default(2)
    .meta(
      ui({ label: '每页行数', field: 'radio', options: { 1: '1 行', 2: '2 行' }, group: '布局' }),
    ),
  paging: z
    .boolean()
    .default(false)
    .meta(ui({ label: '超出时分页滑动', group: '布局' })),
  iconShape: z
    .enum(['circle', 'square'])
    .default('circle')
    .meta(
      ui({
        label: '图标形状',
        field: 'radio',
        options: { circle: '圆形', square: '圆角方形' },
        group: '布局',
      }),
    ),
});
export type NavGridProps = z.infer<typeof navGridProps>;

export const navGridBlock = defineBlock({
  type: 'navGrid',
  v: 1,
  props: navGridProps,
  meta: { label: '导航宫格', pages: ['home', 'custom', 'user_center'] },
});
