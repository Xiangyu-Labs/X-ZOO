import type { Metadata } from 'next';

import { AdminsPage } from './admins';

export const metadata: Metadata = { title: '管理员' };

export default function Page() {
  return <AdminsPage />;
}
