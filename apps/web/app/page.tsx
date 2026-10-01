import type { Metadata } from 'next';
import { cache } from 'react';

import { LandingPage } from '@/landing/landing-page';
import { loadLanding } from '@/server/landing';

/**
 * `/` — the landing page: the shop's name, the 小程序码, "open it in WeChat".
 *
 * The edge proxies exactly `/` here and redirects every path it does not know
 * to it (docker/edge/nginx.conf, docs/mini/cutover.md §2.10). It inherits the
 * root layout's `robots: noindex`.
 */
export const dynamic = 'force-dynamic';

/** Once per request: the metadata and the page read the same settings. */
const load = cache(loadLanding);

export async function generateMetadata(): Promise<Metadata> {
  const { shopName } = await load();
  return {
    title: { absolute: shopName ?? '商城' },
    description: '请使用微信扫码打开小程序',
  };
}

export default async function RootPage() {
  return <LandingPage data={await load()} />;
}
