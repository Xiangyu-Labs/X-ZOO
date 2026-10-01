import type { Metadata } from 'next';

import { ProductReviewsPage } from './product-reviews';

export const metadata: Metadata = { title: '商品评价' };

export default function Page() {
  return <ProductReviewsPage />;
}
