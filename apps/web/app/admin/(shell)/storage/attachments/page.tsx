import type { Metadata } from 'next';

import { AttachmentsPage } from './attachments';

export const metadata: Metadata = { title: '素材库' };

export default function Page() {
  return <AttachmentsPage />;
}
