import type { ReactNode } from 'react';

import { SessionProvider } from '@/admin/session/session-provider';
import { AdminShell } from '@/admin/shell/admin-shell';
import { ContentBoundary } from '@/admin/shell/content-boundary';
import { StorageAssetSourceProvider } from '@/admin/storage/asset-source-provider';

/**
 * Everything behind a login lives under this route group. The group's
 * parentheses keep it out of the URL: `app/admin/(shell)/coupons` is `/admin/coupons`.
 *
 * `StorageAssetSourceProvider` puts the real `/admin-api/attachments` library
 * behind every `<AssetPicker>` in the shell, for every page at once. The kit
 * has no fallback source, so a picker outside it throws.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <StorageAssetSourceProvider>
        <AdminShell>
          <ContentBoundary>{children}</ContentBoundary>
        </AdminShell>
      </StorageAssetSourceProvider>
    </SessionProvider>
  );
}
