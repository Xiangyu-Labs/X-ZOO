import type { Metadata } from 'next';

import { WechatMediaPage } from './wechat-media';

export const metadata: Metadata = { title: '微信素材' };

export default function Page() {
  return <WechatMediaPage />;
}
