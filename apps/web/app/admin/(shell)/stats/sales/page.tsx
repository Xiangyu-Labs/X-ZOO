import type { Metadata } from 'next';

import { RequirePermission } from '@/admin/session/can';

import { SalesStatsPage } from './sales-stats';

export const metadata: Metadata = { title: '销售看板' };

export default function Page() {
  return (
    <RequirePermission permission="stats:sales:read">
      <SalesStatsPage />
    </RequirePermission>
  );
}
