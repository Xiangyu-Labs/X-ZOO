import type { Metadata } from 'next';

import { ForbiddenResult } from '@/admin/session/can';

export const metadata: Metadata = { title: '没有权限' };

/** Somewhere to send an operator who followed a link they may not open. */
export default function ForbiddenPage() {
  return <ForbiddenResult />;
}
