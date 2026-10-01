import type { Metadata } from 'next';

import { NotificationTemplatesPage } from './notification-templates';

export const metadata: Metadata = { title: '通知模板' };

export default function Page() {
  return <NotificationTemplatesPage />;
}
