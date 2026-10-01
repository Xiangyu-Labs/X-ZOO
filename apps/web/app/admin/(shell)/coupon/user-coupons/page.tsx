import type { Metadata } from 'next';

import { UserCouponsPage } from './user-coupons';

export const metadata: Metadata = { title: '已领取记录' };

export default function Page() {
  return <UserCouponsPage />;
}
