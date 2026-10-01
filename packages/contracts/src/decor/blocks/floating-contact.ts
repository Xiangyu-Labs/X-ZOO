import { z } from 'zod';

import { blockProps } from '../base';
import { FLOATING_BOTTOM, FLOATING_SIDES, type FloatingSide } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * 悬浮客服: a round button fixed to one edge of the screen that starts a 客服
 * conversation — the `contact` intent, which the host draws as WeChat's
 * `<button open-type="contact">` (or its own 客服 route elsewhere, or nothing
 * when the shop has no 客服 configured).
 *
 * Fixed, so its place in the block list does not matter, and **one per page**
 * (DECOR-018): two would sit on top of each other. The editor draws it in the
 * flow, where the operator can select it.
 */
export const floatingContactProps = blockProps({
  label: z
    .string()
    .max(4)
    .default('客服')
    .meta(ui({ label: '按钮文字（留空只显示图标）', group: '内容' })),
  side: z
    .enum(Object.keys(FLOATING_SIDES) as [FloatingSide, ...FloatingSide[]])
    .default('right')
    .meta(ui({ label: '位置', field: 'radio', options: FLOATING_SIDES, group: '内容' })),
  bottom: z
    .number()
    .int()
    .min(FLOATING_BOTTOM.min)
    .max(FLOATING_BOTTOM.max)
    .default(FLOATING_BOTTOM.default)
    .meta(ui({ label: '距底部', step: 10, group: '内容' })),
});
export type FloatingContactProps = z.infer<typeof floatingContactProps>;

export const floatingContactBlock = defineBlock({
  type: 'floatingContact',
  v: 1,
  props: floatingContactProps,
  meta: { label: '悬浮客服', pages: ['home', 'custom', 'user_center'], maxPerPage: 1 },
});
