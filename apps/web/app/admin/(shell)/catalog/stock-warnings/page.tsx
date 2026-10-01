import type { Metadata } from 'next';

import { StockWarningsPage } from './stock-warnings';

export const metadata: Metadata = { title: '库存预警' };

export default function Page() {
  return <StockWarningsPage />;
}
