import Taro from '@tarojs/taro';
import type { LinkTarget } from '@shop/contracts/decor/link';
import { linkTargetRoute } from '@shop/contracts/decor/link-route';
import { showToast } from './feedback';
import { navigate } from './nav';
import { openExternalLink } from './webview';

/**
 * Opens what a decorated link points at (`LinkTarget`, decor contracts): a DIY block's `onLink`,
 * the splash ad (`app/config.splashAd.link`), anything an operator picked in the admin.
 *
 * - catalogue kinds (`product`, `category`, `article`, `page`, `route`) → `navigate`;
 * - `webview` → `openExternalLink` (the 业务域名 check, C12: copied when not allowed);
 * - `miniprogram` → `navigateToMiniProgram`; the shopper cancelling is not an error.
 *
 * `null` (a block or splash with no link) does nothing. Call it from the tap handler.
 */
export async function openLinkTarget(link: LinkTarget | null | undefined): Promise<void> {
  if (!link) return;
  switch (link.kind) {
    case 'webview':
      await openExternalLink(link.url);
      return;
    case 'miniprogram':
      try {
        await Taro.navigateToMiniProgram({
          appId: link.appId,
          ...(link.path ? { path: link.path } : {}),
        });
      } catch (error) {
        const message = (error as { errMsg?: unknown } | null)?.errMsg;
        if (typeof message === 'string' && /cancel/i.test(message)) return;
        showToast('暂时无法打开该小程序');
      }
      return;
    default: {
      const route = linkTargetRoute(link);
      if (route) await navigate(route);
    }
  }
}
