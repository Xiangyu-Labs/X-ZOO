import type { Metadata } from 'next';

import { ExpressCompaniesPage } from './express-companies';

export const metadata: Metadata = { title: '快递公司' };

export default function Page() {
  return <ExpressCompaniesPage />;
}
