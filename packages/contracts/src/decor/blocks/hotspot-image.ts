import { z } from 'zod';

import { blockProps, imageUrl } from '../base';
import { linkTarget } from '../link';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * 热区图: one picture with rectangular tap areas. A hotspot's box is in
 * percent of the picture (`x`, `y` its top-left corner, `w`, `h` its size),
 * so it lands on the same spot at any screen width. The editor draws them on
 * the picture (`field: 'hotspots'`).
 */
const percent = z.number().min(0).max(100);

export const hotspot = z
  .object({
    x: percent.meta(ui({ label: '左（%）' })),
    y: percent.meta(ui({ label: '上（%）' })),
    w: z
      .number()
      .min(1)
      .max(100)
      .meta(ui({ label: '宽（%）' })),
    h: z
      .number()
      .min(1)
      .max(100)
      .meta(ui({ label: '高（%）' })),
    /** Accessibility label; not shown. */
    label: z
      .string()
      .max(20)
      .default('')
      .meta(ui({ label: '热区说明' })),
    link: linkTarget.meta(ui({ label: '跳转链接', field: 'link' })),
  })
  .refine((spot) => spot.x + spot.w <= 100.001 && spot.y + spot.h <= 100.001, {
    message: '热区超出图片范围',
  });
export type Hotspot = z.infer<typeof hotspot>;

export const hotspotImageProps = blockProps({
  image: imageUrl.meta(ui({ label: '图片', field: 'image', group: '内容' })),
  hotspots: z
    .array(hotspot)
    .max(20)
    .default([])
    .meta(ui({ label: '热区', field: 'hotspots', itemLabel: 'label', group: '内容' })),
});
export type HotspotImageProps = z.infer<typeof hotspotImageProps>;

export const hotspotImageBlock = defineBlock({
  type: 'hotspotImage',
  v: 1,
  props: hotspotImageProps,
  meta: { label: '热区图', pages: ['home', 'custom', 'user_center'] },
});
