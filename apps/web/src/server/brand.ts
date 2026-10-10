import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import { anonymousActor, createCtx, type Ctx } from '@shop/core/kernel';
import { orNull, siteConfig } from '@shop/core/system';

import { NO_BRAND, type AdminBrand } from '@/admin/shell/brand';
import { getContainer } from './container';

/**
 * The pictures 站点设置 → Logo gives the admin: 后台 Logo, 方形 Logo and
 * 浏览器图标. `app/admin/layout.tsx` reads them for every page under `/admin`,
 * the login page included, so it reads without a session.
 *
 * Nothing here throws: a database that cannot be reached leaves the default
 * mark in the sidebar, never a 500 on every admin page (or on the login page
 * the operator needs to see what is wrong).
 */
export async function brandData(ctx: Ctx): Promise<AdminBrand> {
  try {
    const site = await ctx.config.get(siteConfig);
    return {
      logo: orNull(site.logo),
      square: orNull(site.logoSquare),
      favicon: orNull(site.favicon),
    };
  } catch (error) {
    ctx.logger.warn({ err: error }, 'brand: site settings unavailable, showing the default mark');
    return NO_BRAND;
  }
}

/** Once per request: the layout's metadata and its body read the same settings. */
export const loadBrand = cache(async (): Promise<AdminBrand> => {
  let ctx: Ctx;
  try {
    ctx = brandCtx();
  } catch (error) {
    console.error('brand: no server container', error);
    return NO_BRAND;
  }
  return brandData(ctx);
});

/** An anonymous request context, as `landing.ts` builds its own. */
function brandCtx(): Ctx {
  const container = getContainer();
  const requestId = randomUUID();
  return createCtx({
    db: container.db,
    redis: container.redis,
    clock: container.clock,
    config: container.config,
    logger: container.logger.child({ requestId, routeId: 'web.brand' }),
    queue: container.queue,
    storage: container.storage,
    actor: anonymousActor,
    platform: null,
    requestId,
    routeId: 'web.brand',
  });
}
