import type { Metadata } from 'next';

import { NotificationLogsPage } from './notification-logs';

export const metadata: Metadata = { title: '发送记录' };

export default function Page() {
  return <NotificationLogsPage />;
}
