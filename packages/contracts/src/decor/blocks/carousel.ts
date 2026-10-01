import { z } from 'zod';

import { blockProps, color, imageUrl } from '../base';
import { linkTarget } from '../link';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/** 轮播. */
export const carouselSlide = z.object({
  image: imageUrl,
  link: linkTarget.optional().meta(ui({ label: '跳转链接', field: 'link' })),
  /** Accessibility label; not shown. */
  alt: z
    .string()
    .max(40)
    .default('')
    .meta(ui({ label: '图片说明' })),
});

export const carouselProps = blockProps({
  slides: z
    .array(carouselSlide)
    .min(1, '至少一张图片')
    .max(10)
    .meta(ui({ label: '图片', field: 'array', itemLabel: 'alt', group: '内容' })),
  /** Height on the 750-wide design, in design px. */
  height: z
    .number()
    .int()
    .min(100)
    .max(1000)
    .default(340)
    .meta(ui({ label: '高度（750 设计稿 px）', step: 10, group: '内容' })),
  autoplay: z
    .boolean()
    .default(true)
    .meta(ui({ label: '自动播放', group: '播放' })),
  interval: z
    .number()
    .int()
    .min(1000)
    .max(10000)
    .default(3000)
    .meta(ui({ label: '切换间隔（毫秒）', step: 500, group: '播放' })),
  indicator: z
    .enum(['dots', 'none'])
    .default('dots')
    .meta(
      ui({
        label: '指示点',
        field: 'radio',
        options: { dots: '显示', none: '隐藏' },
        group: '播放',
      }),
    ),
  indicatorColor: color.default('#ffffff80').meta(ui({ label: '指示点颜色', group: '播放' })),
  indicatorActiveColor: color
    .default('#ffffff')
    .meta(ui({ label: '当前指示点颜色', group: '播放' })),
});

export type CarouselProps = z.infer<typeof carouselProps>;
export type CarouselSlide = z.infer<typeof carouselSlide>;

export const carouselBlock = defineBlock({
  type: 'carousel',
  v: 1,
  props: carouselProps,
  meta: { label: '轮播', pages: ['home', 'custom', 'user_center'] },
});
