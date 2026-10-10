'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { NO_BRAND, type AdminBrand } from './brand';

/**
 * Read on the server (`src/server/brand.ts`) by `app/admin/layout.tsx` and
 * handed down here, so the sidebar and the login card show the shop's own
 * pictures on the first paint, without a request of their own — the login page
 * has no session to make one with. Saving 站点设置 calls `router.refresh()`,
 * which re-runs the layout and brings the new pictures.
 */
const BrandContext = createContext<AdminBrand>(NO_BRAND);

export function BrandProvider({ brand, children }: { brand: AdminBrand; children: ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

/** Outside a provider (tests, the kit gallery) every picture is absent: the default mark shows. */
export function useBrand(): AdminBrand {
  return useContext(BrandContext);
}
