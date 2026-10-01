import type { Metadata } from 'next';

import { CustomersPage } from './customers';

export const metadata: Metadata = { title: '用户列表' };

export default function Page() {
  return <CustomersPage />;
}
