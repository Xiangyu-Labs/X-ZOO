import type { Metadata } from 'next';

import { ProductEditorPage } from '../product-editor';

export const metadata: Metadata = { title: '新建商品' };

export default function Page() {
  return <ProductEditorPage />;
}
