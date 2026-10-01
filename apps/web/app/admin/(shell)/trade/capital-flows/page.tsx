import type { Metadata } from 'next';

import { CapitalFlowsPage } from './capital-flows';

export const metadata: Metadata = { title: '资金流水' };

export default function Page() {
  return <CapitalFlowsPage />;
}
