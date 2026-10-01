import type { Locator, Page } from '@playwright/test';

/**
 * Taro's H5 router keeps every page of the stack in the DOM and hides all but the top one, so
 * a word on the page below (订单详情 under 物流) still matches. Page objects look only at what
 * is shown: `shown(page).getByText(…)` finds only visible elements.
 */
export function shown(
  page: Page,
): Pick<Page, 'locator' | 'getByText' | 'getByRole' | 'getByPlaceholder'> {
  const visible = (locator: Locator) => locator.filter({ visible: true });
  return {
    locator: (selector, options) => visible(page.locator(selector, options)),
    getByText: (text, options) => visible(page.getByText(text, options)),
    getByRole: (role, options) => visible(page.getByRole(role, options)),
    getByPlaceholder: (text, options) => visible(page.getByPlaceholder(text, options)),
  };
}

/**
 * Opens a page of the app by its URL as a fresh start, the way a shared link or a 服务通知
 * opens it. Taro's H5 router does not treat a hash change to a page already in its stack as a
 * new page (it shows nothing), so a spec that reopens a page by URL loads the app again; the
 * session survives in `localStorage`.
 */
export async function openFresh(page: Page, url: string): Promise<void> {
  const running = page.url().startsWith('http');
  await page.goto(url);
  // A hash change only: load the app again at that route.
  if (running) await page.reload();
}
