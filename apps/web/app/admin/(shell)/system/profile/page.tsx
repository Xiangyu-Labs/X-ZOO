import type { Metadata } from 'next';

import { ProfilePage } from './profile';

export const metadata: Metadata = { title: '个人资料' };

export default function Page() {
  return <ProfilePage />;
}
