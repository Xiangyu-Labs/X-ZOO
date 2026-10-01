import type { Metadata } from 'next';

import { OrderDetailPage } from './order-detail';

export const metadata: Metadata = { title: '订单详情' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetailPage id={id} />;
}
