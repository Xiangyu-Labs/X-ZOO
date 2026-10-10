/**
 * The pictures 站点设置 → Logo gives the admin, each `null` when not filled in.
 *
 * A plain module, not the client context beside it: `src/server/brand.ts`
 * builds this shape on the server, and a value imported from a `'use client'`
 * file is only a reference there.
 *
 * URLs are used as stored (`/uploads/…` is same-origin, like every other image
 * the admin shows).
 */
export interface AdminBrand {
  /** 后台 Logo: the expanded sidebar and the login card. */
  logo: string | null;
  /** 方形 Logo: the collapsed sidebar. */
  square: string | null;
  /** 浏览器图标: the tab icon, set by `app/admin/layout.tsx`'s metadata. */
  favicon: string | null;
}

export const NO_BRAND: AdminBrand = { logo: null, square: null, favicon: null };
