import { cookies } from 'next/headers';
import Link from 'next/link';

import { THEME_COOKIE_KEY } from '@/admin/theme/tokens';

/** antd's own neutrals and primary, for the two themes; no antd provider here to ask. */
const PALETTE = {
  light: {
    page: '#f5f5f5',
    text: 'rgba(0, 0, 0, 0.88)',
    muted: 'rgba(0, 0, 0, 0.45)',
    link: '#1677ff',
  },
  dark: {
    page: '#000000',
    text: 'rgba(255, 255, 255, 0.85)',
    muted: 'rgba(255, 255, 255, 0.45)',
    link: '#1668dc',
  },
} as const;

/**
 * Every URL nothing serves, outside the admin shell (which has its own).
 *
 * Next's default is an English page; this one says the same in Chinese and
 * offers the way back. Plain markup rather than antd: it renders under the
 * root layout, without the admin providers — so it reads the theme cookie the
 * admin writes itself, and a dark-mode operator is not flashed a white page.
 */
export default async function NotFound() {
  const store = await cookies();
  const colours = PALETTE[store.get(THEME_COOKIE_KEY)?.value === 'dark' ? 'dark' : 'light'];
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
        background: colours.page,
        color: colours.text,
      }}
    >
      <h1 style={{ fontSize: 48, margin: 0, color: colours.muted }}>404</h1>
      <p style={{ margin: 0 }}>你访问的页面不存在</p>
      <Link href="/admin" style={{ color: colours.link }}>
        返回管理后台
      </Link>
    </main>
  );
}
