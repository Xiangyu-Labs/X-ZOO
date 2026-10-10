/**
 * The shop's mark: a white shopping bag on the storefront red. `app/icon.svg` and
 * `public/favicon.ico` draw the same thing, so the browser tab, the sidebar and the
 * login card agree. Change all three together.
 *
 * It is the default: 站点设置's 后台 Logo, 方形 Logo and 浏览器图标 replace it
 * where they are set (`brand-context.tsx`).
 */
export const BRAND_RED = '#E1251B';

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect width="32" height="32" rx="8" fill={BRAND_RED} />
      <path
        d="M12.5 12v-1.5a3.5 3.5 0 0 1 7 0V12"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M9 12h14l-1.1 11.3a1.8 1.8 0 0 1-1.8 1.7h-8.2a1.8 1.8 0 0 1-1.8-1.7z" fill="#fff" />
      <path
        d="M13 16.5a3 3 0 0 0 6 0"
        fill="none"
        stroke={BRAND_RED}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
