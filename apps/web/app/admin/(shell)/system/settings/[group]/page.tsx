import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SettingsGroupPage } from './settings-group';

export const metadata: Metadata = { title: '配置分组' };

/**
 * `params` is a promise in the App Router, so the server component awaits it
 * and hands the client component a plain string.
 */
export default async function Page({ params }: { params: Promise<{ group: string }> }) {
  const { group } = await params;
  // `useSearchParams` (for `?field=`, from the settings search) needs a
  // Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <SettingsGroupPage group={group} />
    </Suspense>
  );
}
