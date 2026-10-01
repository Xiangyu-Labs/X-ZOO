import type { Metadata } from 'next';

import { UserLabelsPage } from './labels';

export const metadata: Metadata = { title: '用户标签' };

export default function Page() {
  return <UserLabelsPage />;
}
