import type { Metadata } from 'next';

import { OrdersPage } from './orders';

export const metadata: Metadata = { title: '订单列表' };

export default function Page() {
  return <OrdersPage />;
}
