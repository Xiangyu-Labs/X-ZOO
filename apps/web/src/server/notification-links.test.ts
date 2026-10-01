import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '@shop/core/domains';
import { allNotificationEvents } from '@shop/core/notification';

/**
 * An admin notification's link is the button a person presses to act on it.
 * `/admin/refunds/{{refundId}}` and `/admin/payment-exceptions/{{exceptionId}}`
 * pointed at pages that never existed, so 「新的退款申请」 and 「支付异常待处理」
 * opened the 404 page. Every link now has to land on a page in the console.
 */

const SHELL = path.resolve(import.meta.dirname, '../../app/admin/(shell)');

/** Walks the app directory the way the router does: a literal segment, or a `[param]` one. */
function pageExists(pathname: string): boolean {
  const segments = pathname
    .replace(/^\/admin\/?/, '')
    .split('/')
    .filter(Boolean);
  let dir = SHELL;
  for (const segment of segments) {
    const placeholder = /^\{\{\w+\}\}$/.test(segment);
    if (!placeholder && existsSync(path.join(dir, segment))) {
      dir = path.join(dir, segment);
      continue;
    }
    const dynamic = readdirSync(dir, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && /^\[[^.]\w*\]$/.test(entry.name),
    );
    if (!dynamic) return false;
    dir = path.join(dir, dynamic.name);
  }
  return existsSync(path.join(dir, 'page.tsx'));
}

describe('NOTIF-008 — every admin notification links to a page that exists', () => {
  it('resolves each link to a console page', () => {
    const admin = allNotificationEvents().filter((event) => event.audience === 'admin');
    expect(admin.length).toBeGreaterThan(5);
    const broken = admin
      .filter((event) => event.link !== undefined)
      .filter((event) => {
        const [pathname = ''] = event.link!.split('?');
        return !pathname.startsWith('/admin/') || !pageExists(pathname);
      })
      .map((event) => `${event.code}: ${event.link}`);
    expect(broken).toEqual([]);
  });

  it('opens the one record on a list page through ?detail=', () => {
    const detailLinks = allNotificationEvents()
      .map((event) => event.link ?? '')
      .filter((link) => link.includes('?'));
    expect(detailLinks.length).toBeGreaterThan(0);
    for (const link of detailLinks) expect(link).toMatch(/\?detail=\{\{\w+\}\}$/);
  });
});
