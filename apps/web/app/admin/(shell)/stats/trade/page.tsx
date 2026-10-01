import type { Metadata } from 'next';

import { RequirePermission } from '@/admin/session/can';

import { TradeStatsPage } from './trade-stats';

export const metadata: Metadata = { title: '交易统计' };

export default function Page() {
  return (
    <RequirePermission permission="stats:trade:read">
      <TradeStatsPage />
    </RequirePermission>
  );
}
