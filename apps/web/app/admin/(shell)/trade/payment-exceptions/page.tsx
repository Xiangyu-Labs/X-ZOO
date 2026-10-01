import type { Metadata } from 'next';

import { PaymentExceptionsPage } from './payment-exceptions';

export const metadata: Metadata = { title: '异常支付' };

export default function Page() {
  return <PaymentExceptionsPage />;
}
