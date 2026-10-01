import { copyText } from './clipboard';
import { showToast } from './feedback';
import { navigate } from './nav';

/**
 * External links (C12). A `web-view` may only open a 业务域名 configured in the WeChat console:
 * official-account articles (`mp.weixin.qq.com`) and the shop's own list
 * (`app/config.webviewDomains`). Anything else is copied for the shopper to open in a browser.
 */
const ALWAYS_ALLOWED = ['mp.weixin.qq.com'];

let domains: readonly string[] = [];

/** The shop's 业务域名 list, from `app/config` (src/app-config). */
export function setWebviewDomains(list: readonly string[]): void {
  domains = list.map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** Whether `url` may open in the web-view: https, and the host is on the list. */
export function isWebviewAllowed(url: string): boolean {
  const match = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url.trim());
  if (!match) return false;
  const host = (match[1] ?? '').toLowerCase();
  return ALWAYS_ALLOWED.includes(host) || domains.includes(host);
}

/** Opens an external link in the web-view, or copies it when WeChat would refuse it. */
export async function openExternalLink(url: string): Promise<void> {
  if (isWebviewAllowed(url)) {
    await navigate({ route: 'webview', params: { url } });
    return;
  }
  if (await copyText(url)) showToast('链接已复制，请在浏览器中打开');
}
