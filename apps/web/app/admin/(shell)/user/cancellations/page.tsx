import type { Metadata } from 'next';

import { CancellationsPage } from './cancellations';

export const metadata: Metadata = { title: '注销申请' };

export default function Page() {
  return <CancellationsPage />;
}
