import type { Metadata } from 'next';

import { ProductProtectionsPage } from './product-protections';

export const metadata: Metadata = { title: '商品保障服务' };

export default function Page() {
  return <ProductProtectionsPage />;
}
