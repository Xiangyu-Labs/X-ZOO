import type { Metadata } from 'next';

import { RefundRequestsPage } from './refund-requests';

export const metadata: Metadata = { title: '售后单' };

export default function Page() {
  return <RefundRequestsPage />;
}
