import type { Metadata } from 'next';

import { OrderInvoicesPage } from './order-invoices';

export const metadata: Metadata = { title: '发票管理' };

export default function Page() {
  return <OrderInvoicesPage />;
}
