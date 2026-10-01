import type { Metadata } from 'next';

import { RequirePermission } from '@/admin/session/can';

import { ProductStatsPage } from './product-stats';

export const metadata: Metadata = { title: '商品统计' };

export default function Page() {
  return (
    <RequirePermission permission="stats:product:read">
      <ProductStatsPage />
    </RequirePermission>
  );
}
