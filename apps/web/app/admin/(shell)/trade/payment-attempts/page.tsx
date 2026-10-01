import type { Metadata } from 'next';

import { PaymentAttemptsPage } from './payment-attempts';

export const metadata: Metadata = { title: '支付记录' };

export default function Page() {
  return <PaymentAttemptsPage />;
}
