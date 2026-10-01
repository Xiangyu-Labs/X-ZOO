import type { Metadata } from 'next';

import { RolesPage } from './roles';

export const metadata: Metadata = { title: '身份管理' };

export default function Page() {
  return <RolesPage />;
}
