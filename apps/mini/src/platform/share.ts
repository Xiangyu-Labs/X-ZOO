import { useShareAppMessage, useShareTimeline } from '@tarojs/taro';
import { storefrontRoutes, type StorefrontRoute } from '@shop/api-client/routes';
import { toPath } from './nav';

/**
 * Sharing through the route catalogue (C10): a page names a `StorefrontRoute`, never a path.
 *
 * `useShare(route, content)` answers WeChat's share menu. What the menu offers follows the
 * catalogue's `share` for the key: `friend` (好友) or `friend+timeline` (好友 + 朋友圈); the
 * page config must also set `enableShareAppMessage` / `enableShareTimeline` to match (Taro only
 * registers the handlers for a page that declares them). A `friend+timeline` page must render
 * anonymously in the timeline's single-page mode (`isTimelineSinglePage`, platform/launch).
 */
export interface ShareContent {
  title?: string | undefined;
  imageUrl?: string | undefined;
}

let defaults: ShareContent = {};

/** The shop's share title and picture (`app/config.share`), for pages that set none. */
export function setShareDefaults(content: ShareContent): void {
  defaults = content;
}

function pick(content: ShareContent): { title?: string; imageUrl?: string } {
  const title = content.title || defaults.title;
  const imageUrl = content.imageUrl || defaults.imageUrl;
  return { ...(title ? { title } : {}), ...(imageUrl ? { imageUrl } : {}) };
}

/** `onShareAppMessage`'s answer for a route. */
export function shareMessage(route: StorefrontRoute, content: ShareContent = {}) {
  return { ...pick(content), path: toPath(route) };
}

/** `onShareTimeline`'s answer: the timeline opens the current page with `query`. */
export function shareTimeline(route: StorefrontRoute, content: ShareContent = {}) {
  const path = toPath(route);
  const at = path.indexOf('?');
  return { ...pick(content), query: at < 0 ? '' : path.slice(at + 1) };
}

/**
 * Registers the page's share handlers. `route` may be `null` while the page's data loads: the
 * share then points at the home page, which is always a valid landing.
 */
export function useShare(route: StorefrontRoute | null, content: ShareContent = {}): void {
  const target: StorefrontRoute = route ?? { route: 'home', params: {} };
  const mode = storefrontRoutes[target.route].share;
  useShareAppMessage(() =>
    shareMessage(mode === 'none' ? { route: 'home', params: {} } : target, content),
  );
  useShareTimeline(() =>
    shareTimeline(mode === 'friend+timeline' ? target : { route: 'home', params: {} }, content),
  );
}
