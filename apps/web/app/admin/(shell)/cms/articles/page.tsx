import type { Metadata } from 'next';

import { ArticlesPage } from './articles';

export const metadata: Metadata = { title: '文章管理' };

export default function Page() {
  return <ArticlesPage />;
}
