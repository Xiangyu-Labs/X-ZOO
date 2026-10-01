import { z } from 'zod';

import { blockProps } from '../base';
import { linkTarget } from '../link';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/** 标题栏: a section heading, with an optional subtitle and 「更多」 link. */
export const titleBarProps = blockProps({
  title: z
    .string()
    .trim()
    .min(1, '请填写标题')
    .max(16)
    .default('标题')
    .meta(ui({ label: '标题', group: '内容' })),
  subtitle: z
    .string()
    .max(30)
    .default('')
    .meta(ui({ label: '副标题（留空不显示）', group: '内容' })),
  align: z
    .enum(['left', 'center'])
    .default('left')
    .meta(
      ui({
        label: '对齐',
        field: 'radio',
        options: { left: '居左', center: '居中' },
        group: '内容',
      }),
    ),
  moreText: z
    .string()
    .max(6)
    .default('更多')
    .meta(ui({ label: '「更多」文字', group: '更多' })),
  /** The 「更多」 entry shows only with a link. */
  moreLink: linkTarget
    .optional()
    .meta(ui({ label: '「更多」链接（不选不显示）', field: 'link', group: '更多' })),
});
export type TitleBarProps = z.infer<typeof titleBarProps>;

export const titleBarBlock = defineBlock({
  type: 'titleBar',
  v: 1,
  props: titleBarProps,
  meta: { label: '标题栏', pages: ['home', 'custom', 'user_center'] },
});
