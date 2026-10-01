import type { Metadata } from 'next';

import { RequirePermission } from '@/admin/session/can';

import { UserStatsPage } from './user-stats';

export const metadata: Metadata = { title: '用户统计' };

export default function Page() {
  return (
    <RequirePermission permission="stats:user:read">
      <UserStatsPage />
    </RequirePermission>
  );
}
