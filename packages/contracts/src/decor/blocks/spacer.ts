import { z } from 'zod';

import { blockProps, color } from '../base';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * 间隔 / 分割线, one block: blank space of `height`, with an optional rule
 * across its middle. One block rather than two because an operator reaches
 * for either to separate sections, and the only difference is the line.
 */
export const spacerProps = blockProps({
  height: z
    .number()
    .int()
    .min(8)
    .max(200)
    .default(24)
    .meta(ui({ label: '高度（750 设计稿 px）', step: 4, group: '内容' })),
  line: z
    .enum(['none', 'solid', 'dashed'])
    .default('none')
    .meta(
      ui({
        label: '分割线',
        field: 'radio',
        options: { none: '无（空白）', solid: '实线', dashed: '虚线' },
        group: '内容',
      }),
    ),
  lineColor: color
    .optional()
    .meta(ui({ label: '线条颜色（不选用默认）', field: 'color', group: '内容' })),
  /** Leave the page gutter on both sides of the line. */
  inset: z
    .boolean()
    .default(true)
    .meta(ui({ label: '线条两侧留白', group: '内容' })),
});
export type SpacerProps = z.infer<typeof spacerProps>;

export const spacerBlock = defineBlock({
  type: 'spacer',
  v: 1,
  props: spacerProps,
  meta: { label: '间隔/分割线', pages: ['home', 'custom', 'user_center'] },
});
