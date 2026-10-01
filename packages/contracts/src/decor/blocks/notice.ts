import { z } from 'zod';

import { blockProps } from '../base';
import { linkTarget } from '../link';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * 公告: short lines of text behind a label. `scroll` shows one line at a time,
 * rolling up every `interval` ms (never faster than 4 s, design.md §motion);
 * `static` lists every line.
 */
export const noticeLine = z.object({
  text: z
    .string()
    .trim()
    .min(1, '请填写公告内容')
    .max(60)
    .meta(ui({ label: '内容' })),
  link: linkTarget.optional().meta(ui({ label: '跳转链接', field: 'link' })),
});
export type NoticeLine = z.infer<typeof noticeLine>;

export const noticeProps = blockProps({
  label: z
    .string()
    .max(4)
    .default('公告')
    .meta(ui({ label: '标签（留空不显示）', group: '内容' })),
  lines: z
    .array(noticeLine)
    .min(1, '至少一条公告')
    .max(10)
    .meta(ui({ label: '公告', field: 'array', itemLabel: 'text', group: '内容' })),
  mode: z
    .enum(['scroll', 'static'])
    .default('scroll')
    .meta(
      ui({
        label: '展示方式',
        field: 'radio',
        options: { scroll: '滚动', static: '平铺' },
        group: '播放',
      }),
    ),
  interval: z
    .number()
    .int()
    .min(4000)
    .max(15000)
    .default(4000)
    .meta(ui({ label: '滚动间隔（毫秒）', step: 500, group: '播放' })),
});
export type NoticeProps = z.infer<typeof noticeProps>;

export const noticeBlock = defineBlock({
  type: 'notice',
  v: 1,
  props: noticeProps,
  meta: { label: '公告', pages: ['home', 'custom', 'user_center'] },
});
