import type { Metadata } from 'next';

import { CouponTemplatesPage } from './coupon-templates';

export const metadata: Metadata = { title: '优惠券列表' };

/**
 * The route file is a server component that renders the client page, which is
 * the split every admin page uses: metadata and any server-side guard stay
 * here, hooks and antd stay in the `'use client'` file next to it.
 */
export default function Page() {
  return <CouponTemplatesPage />;
}
