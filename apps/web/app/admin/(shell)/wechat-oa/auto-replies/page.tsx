import type { Metadata } from 'next';

import { WechatAutoRepliesPage } from './wechat-auto-replies';

export const metadata: Metadata = { title: '公众号自动回复' };

export default function Page() {
  return <WechatAutoRepliesPage />;
}
