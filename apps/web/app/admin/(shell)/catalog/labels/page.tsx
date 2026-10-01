import type { Metadata } from 'next';

import { ProductLabelsPage } from './product-labels';

export const metadata: Metadata = { title: '商品标签' };

export default function Page() {
  return <ProductLabelsPage />;
}
