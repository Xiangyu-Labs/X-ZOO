import type { Metadata } from 'next';

import { DashboardPage } from './dashboard';

export const metadata: Metadata = { title: '工作台' };

export default function AdminHome() {
  return <DashboardPage />;
}
