import type { Metadata } from 'next';

import { SettingsIndexPage } from './settings-index';

export const metadata: Metadata = { title: '系统设置' };

export default function Page() {
  return <SettingsIndexPage />;
}
