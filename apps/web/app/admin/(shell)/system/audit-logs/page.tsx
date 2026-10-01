import type { Metadata } from 'next';

import { AuditLogsPage } from './audit-logs';

export const metadata: Metadata = { title: '操作日志' };

export default function Page() {
  return <AuditLogsPage />;
}
