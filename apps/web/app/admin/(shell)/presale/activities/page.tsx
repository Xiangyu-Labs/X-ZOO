import type { Metadata } from 'next';

import { PresaleActivitiesPage } from './presale-activities';

export const metadata: Metadata = { title: '预售活动' };

/**
 * The route file is a server component that renders the client page, which is
 * the split every admin page uses: metadata and any server-side guard stay
 * here, hooks and antd stay in the `'use client'` file next to it.
 */
export default function Page() {
  return <PresaleActivitiesPage />;
}
