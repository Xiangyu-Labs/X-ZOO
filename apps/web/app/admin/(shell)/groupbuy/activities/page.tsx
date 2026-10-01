import type { Metadata } from 'next';

import { GroupbuyActivitiesPage } from './groupbuy-activities';

export const metadata: Metadata = { title: '拼团活动' };

export default function Page() {
  return <GroupbuyActivitiesPage />;
}
