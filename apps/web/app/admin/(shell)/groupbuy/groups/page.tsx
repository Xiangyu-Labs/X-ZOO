import type { Metadata } from 'next';

import { GroupbuyGroupsPage } from './groupbuy-groups';

export const metadata: Metadata = { title: '拼团列表' };

export default function Page() {
  return <GroupbuyGroupsPage />;
}
