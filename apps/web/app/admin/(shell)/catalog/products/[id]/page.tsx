import type { Metadata } from 'next';

import { ProductEditorPage } from '../product-editor';

export const metadata: Metadata = { title: '编辑商品' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductEditorPage productId={id} />;
}
