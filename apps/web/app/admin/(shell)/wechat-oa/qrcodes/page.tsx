import type { Metadata } from 'next';

import { WechatQrcodesPage } from './wechat-qrcodes';

export const metadata: Metadata = { title: '渠道二维码' };

export default function Page() {
  return <WechatQrcodesPage />;
}
