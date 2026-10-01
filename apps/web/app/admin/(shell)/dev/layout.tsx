import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { isProduction } from '@/server/env';

/**
 * The kit demo and the decor sandbox are development tools with fake routes
 * behind them. The menu already hides them in production; this makes the URLs
 * a 404 there too, so nobody lands on a page of dummy data by a shared link.
 *
 * Read at request time from the runtime environment (not the build's
 * `process.env.NODE_ENV`), so the admin e2e suite — a production build served
 * with NODE_ENV=test — still reaches them.
 */
export const dynamic = 'force-dynamic';

export default function DevLayout({ children }: { children: ReactNode }) {
  if (isProduction()) notFound();
  return children;
}
