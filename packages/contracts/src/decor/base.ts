import { z } from 'zod';

import {
  AUDIENCES,
  PLATFORMS,
  RADIUS,
  SPACING,
  type Audience,
  type Platform,
  type Radius,
  type Spacing,
} from './constants';
import { ui } from './meta';

/**
 * The shapes every block shares (plan §2.1): the value primitives, and the
 * base props — `style` (spacing presets, background, radius) and `visibility`
 * (audience, platforms) — that `blockProps()` adds to every block.
 */

function enumOf<const T extends string>(keys: readonly T[]) {
  return z.enum(keys as [T, ...T[]]);
}

/** An image the storefront can load: an uploaded asset URL (or a data URI in fixtures). */
export const imageUrl = z
  .string()
  // `abort`: an empty value is "not picked yet", not also "an invalid address".
  .min(1, { error: '请选择图片', abort: true })
  .max(2048)
  .refine((value) => /^(https?:\/\/|\/|data:image\/)/.test(value), '图片地址无效')
  .meta(ui({ label: '图片', field: 'image' }));

/** `#rgb` / `#rrggbb` / `#rrggbbaa`. */
export const color = z
  .string()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, '颜色格式应为 #RRGGBB')
  .meta(ui({ label: '颜色', field: 'color' }));

/** Money as the API sends it: `"12.00"`. */
export const displayMoney = z.string().regex(/^\d+\.\d{2}$/);

const spacing = enumOf(Object.keys(SPACING) as Spacing[]);
const radius = enumOf(Object.keys(RADIUS) as Radius[]);

/**
 * How a block sits on the page: spacing from preset steps, a background and a
 * corner radius. Presets rather than free numbers, so a theme can retune the
 * steps in one place.
 */
export const blockStyle = z
  .object({
    marginY: spacing
      .default('none')
      .meta(ui({ label: '上下间距', field: 'radio', options: SPACING })),
    paddingX: spacing
      .default('none')
      .meta(ui({ label: '左右留白', field: 'radio', options: SPACING })),
    radius: radius.default('none').meta(ui({ label: '圆角', field: 'radio', options: RADIUS })),
    background: color.optional().meta(ui({ label: '背景色', field: 'color' })),
  })
  .meta(ui({ label: '样式', field: 'object', group: '样式' }));

export type BlockStyle = z.infer<typeof blockStyle>;

export const blockStyleDefaults: BlockStyle = blockStyle.parse({});

/**
 * Who sees a block, and on which client.
 *
 * - `audience`: `guest` shows only without a session (a 「注册领券」 banner),
 *   `member` only with one. Decided per request by the resolver.
 * - `platforms`: empty means every client. Otherwise the block is served only
 *   to a request whose `X-Client-Platform` is listed; a request that names no
 *   platform (a script, the admin preview) sees every block.
 *
 * This is presentation, not access control: a hidden block's props are simply
 * not sent, but nothing in them is secret.
 */
export const blockVisibility = z
  .object({
    audience: enumOf(Object.keys(AUDIENCES) as Audience[])
      .default('all')
      .meta(ui({ label: '可见人群', field: 'radio', options: AUDIENCES })),
    platforms: z
      .array(enumOf(Object.keys(PLATFORMS) as Platform[]))
      .max(3)
      .default([])
      // An array of an enum: the editor draws it as a multi-select (checkboxes).
      .meta(ui({ label: '仅在这些客户端显示（不选即全部）', options: PLATFORMS })),
  })
  .meta(ui({ label: '显示', field: 'object', group: '显示' }));

export type BlockVisibility = z.infer<typeof blockVisibility>;

/** The base props every block carries, keyed as they appear in `props`. */
export const BASE_PROP_KEYS = ['style', 'visibility'] as const;

/**
 * A block's prop schema: its own fields plus the shared base props.
 *
 * `defineBlock` refuses a props schema that does not come from here, so no
 * block can forget its spacing or its visibility.
 */
export function blockProps<const Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({
    ...shape,
    style: blockStyle.prefault({}),
    visibility: blockVisibility.prefault({}),
  });
}
