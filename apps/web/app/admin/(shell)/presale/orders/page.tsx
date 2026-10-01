import type { Metadata } from 'next';

import { PresaleOrdersPage } from './presale-orders';

export const metadata: Metadata = { title: '预售订单' };

export default function Page() {
  return <PresaleOrdersPage />;
}
