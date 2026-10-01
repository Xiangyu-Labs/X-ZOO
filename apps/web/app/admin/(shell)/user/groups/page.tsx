import type { Metadata } from 'next';

import { UserGroupsPage } from './groups';

export const metadata: Metadata = { title: '用户分组' };

export default function Page() {
  return <UserGroupsPage />;
}
