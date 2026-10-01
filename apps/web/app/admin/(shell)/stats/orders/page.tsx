import type { Metadata } from 'next';

import { RequirePermission } from '@/admin/session/can';

import { OrderStatsPage } from './order-stats';

export const metadata: Metadata = { title: '订单统计' };

export default function Page() {
  return (
    <RequirePermission permission="stats:order:read">
      <OrderStatsPage />
    </RequirePermission>
  );
}
