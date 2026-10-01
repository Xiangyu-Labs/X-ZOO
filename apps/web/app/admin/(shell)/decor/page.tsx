import type { Metadata } from 'next';

import { DecorDocumentList } from '@/admin/decor/page-list';

export const metadata: Metadata = { title: '店铺装修' };

export default function DecorListPage() {
  return <DecorDocumentList />;
}
