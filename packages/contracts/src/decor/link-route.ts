import type { StorefrontRoute } from '../system/storefront-routes';
import type { LinkTarget } from './link';

/**
 * The catalogue route a `LinkTarget` opens, or `null` for the two kinds that
 * do not go through the catalogue (`miniprogram` opens another app,
 * `webview` is `webview { url }` but the client must check the host first).
 *
 * Zod-free (types only), so the mini-program can call it.
 */
export function linkTargetRoute(link: LinkTarget): StorefrontRoute | null {
  switch (link.kind) {
    case 'product':
      return { route: 'product', params: { id: link.id } };
    case 'category':
      return { route: 'productList', params: { categoryId: link.id } };
    case 'article':
      return { route: 'article', params: { id: link.id } };
    case 'page':
      return { route: 'page', params: { id: link.id } };
    case 'route':
      return link.to;
    case 'webview':
    case 'miniprogram':
      return null;
  }
}
