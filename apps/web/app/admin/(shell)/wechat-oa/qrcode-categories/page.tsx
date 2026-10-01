import type { Metadata } from 'next';

import { WechatQrcodeCategoriesPage } from './wechat-qrcode-categories';

export const metadata: Metadata = { title: '渠道码分类' };

export default function Page() {
  return <WechatQrcodeCategoriesPage />;
}
