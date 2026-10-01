import type { Metadata } from 'next';

import { ProductListPage } from './product-list';

export const metadata: Metadata = { title: '商品列表' };

export default function Page() {
  return <ProductListPage />;
}
