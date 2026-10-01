import { z } from 'zod';

import { blockProps, imageUrl } from '../base';
import { VIDEO_RATIOS, type VideoRatio } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';

/**
 * A video the storefront can play: an uploaded asset (mp4) URL. Required and
 * without a default, so a new 视频 block cannot be published until one is
 * picked (meta.ts convention 7). The mini-program plays it with the native
 * `<video>`, whose host must be on the 小程序 download domain list — the
 * asset CDN already is.
 */
export const videoUrl = z
  .string()
  .min(1, { error: '请选择视频', abort: true })
  .max(2048)
  .refine((value) => /^(https?:\/\/|\/)/.test(value), '视频地址无效')
  .meta(ui({ label: '视频', field: 'video' }));

/**
 * 视频: one video with an optional poster.
 *
 * Autoplay is off by default (design.md: nothing moves the shopper did not
 * start); an operator who turns it on should keep it muted — WeChat and most
 * browsers only autoplay a muted video. The host pauses and hides the player
 * while an overlay is open (design.md §overlays): the native `<video>` draws
 * above every view.
 */
export const videoProps = blockProps({
  src: videoUrl.meta(ui({ label: '视频（mp4）', field: 'video', group: '内容' })),
  poster: imageUrl
    .optional()
    .meta(ui({ label: '封面图（留空用视频首帧）', field: 'image', group: '内容' })),
  ratio: z
    .enum(Object.keys(VIDEO_RATIOS) as [VideoRatio, ...VideoRatio[]])
    .default('16:9')
    .meta(ui({ label: '画面比例', field: 'radio', options: VIDEO_RATIOS, group: '内容' })),
  autoplay: z
    .boolean()
    .default(false)
    .meta(
      ui({
        label: '自动播放',
        help: '自动播放时请同时开启静音，否则多数手机不会自动播放',
        group: '播放',
      }),
    ),
  muted: z
    .boolean()
    .default(false)
    .meta(ui({ label: '静音', group: '播放' })),
  loop: z
    .boolean()
    .default(false)
    .meta(ui({ label: '循环播放', group: '播放' })),
});
export type VideoProps = z.infer<typeof videoProps>;

export const videoBlock = defineBlock({
  type: 'video',
  v: 1,
  props: videoProps,
  meta: { label: '视频', pages: ['home', 'custom'] },
});
