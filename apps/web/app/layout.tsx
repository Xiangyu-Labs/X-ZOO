import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AntdRegistry } from '@ant-design/nextjs-registry';

import { SITE_TITLE } from '@/admin/site-title';

import './globals.css';

export const metadata: Metadata = {
  title: { default: SITE_TITLE, template: `%s · ${SITE_TITLE}` },
  description: SITE_TITLE,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * `AntdRegistry` collects antd's CSS-in-JS during SSR and inlines it, which is
 * what keeps the first paint unstyled-flash-free under the App Router.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <AntdRegistry>{children}</AntdRegistry>
      </body>
    </html>
  );
}
