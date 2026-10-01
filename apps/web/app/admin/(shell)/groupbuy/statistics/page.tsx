import type { Metadata } from 'next';

import { GroupbuyStatisticsPage } from './groupbuy-statistics';

export const metadata: Metadata = { title: '拼团统计' };

export default function Page() {
  return <GroupbuyStatisticsPage />;
}
