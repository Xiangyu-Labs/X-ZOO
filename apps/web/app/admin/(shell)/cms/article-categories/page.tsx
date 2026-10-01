import type { Metadata } from 'next';

import { ArticleCategoriesPage } from './article-categories';

export const metadata: Metadata = { title: '文章分类' };

export default function Page() {
  return <ArticleCategoriesPage />;
}
