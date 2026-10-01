import { z } from 'zod';
import { id } from '../_conventions/common';
import {
  storefrontRouteDef,
  storefrontRouteKeys,
  type StorefrontMiniCodeKey,
} from '../system/storefront-routes';

/**
 * Shapes for the mini-program WeChat routes.
 *
 * The Official Account's own shapes are in `wechat-oa/schemas.ts`; nothing is
 * shared between the two but the vendor's name.
 */

export const miniCodeResult = z.object({
  /** Public URL of the PNG. Site-relative on the local storage driver. */
  url: z.string(),
});
export type MiniCodeResult = z.infer<typeof miniCodeResult>;

// ---------------------------------------------------------------------------
// 小程序码 from the route catalogue
// ---------------------------------------------------------------------------

/** The catalogue keys marked `miniCode` — the only pages a share code opens. */
export const SHARE_MINI_CODE_ROUTES = storefrontRouteKeys.filter(
  (key) => storefrontRouteDef(key).miniCode === true,
) as [StorefrontMiniCodeKey, ...StorefrontMiniCodeKey[]];

export const shareMiniCodeRoute = z.enum(SHARE_MINI_CODE_ROUTES);

/**
 * `?route=product&id=1024`: a catalogue key and that route's params, flat.
 *
 * Every `miniCode` key takes one `id` or nothing, so `id` is the only param
 * the query knows today; a key that needs another adds it here. Whether the
 * params fit the key is the domain's check (`storefrontRoute` is strict), so
 * `?route=home&id=1` is a `VALIDATION_FAILED`, not a code that ignores `id`.
 */
export const shareMiniCodeQuery = z.object({
  route: shareMiniCodeRoute,
  id: id.optional(),
});
export type ShareMiniCodeQuery = z.infer<typeof shareMiniCodeQuery>;
