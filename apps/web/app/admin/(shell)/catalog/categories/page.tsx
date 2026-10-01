import type { Metadata } from 'next';

import { ProductCategoriesPage } from './product-categories';

export const metadata: Metadata = { title: '商品分类' };

export default function Page() {
  return <ProductCategoriesPage />;
}
