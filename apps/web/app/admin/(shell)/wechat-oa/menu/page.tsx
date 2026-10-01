import type { Metadata } from 'next';

import { WechatMenusPage } from './wechat-menus';

export const metadata: Metadata = { title: '公众号自定义菜单' };

export default function Page() {
  return <WechatMenusPage />;
}
