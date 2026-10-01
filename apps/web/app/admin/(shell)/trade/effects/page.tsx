import type { Metadata } from 'next';

import { PaymentEffectsPage } from './payment-effects';

export const metadata: Metadata = { title: '待处理任务' };

export default function Page() {
  return <PaymentEffectsPage />;
}
