import type { Metadata } from 'next';

import { ApiTokensPage } from './api-tokens';

export const metadata: Metadata = { title: 'API 令牌' };

export default function Page() {
  return <ApiTokensPage />;
}
