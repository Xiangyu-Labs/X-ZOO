import { systemAppConfigGet } from '@shop/contracts/system/system.app.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/app/config` — 小程序启动配置.
 *
 * Public: the mini-program reads it on launch, before there is a session, to
 * paint the theme and tab bar and decide which sign-in to offer.
 *
 * A caller holding the current version gets a bodyless 304. The version is the
 * newest save across every config group the payload is built from
 * (`appConfigSourceGroups`), so any save that can change the answer moves it.
 * Weak: the JSON is rebuilt per request.
 */
export const GET = handle(systemAppConfigGet, async (ctx) => {
  const config = await system.appConfigGet(ctx);
  if (ctx.etag(config.version, { weak: true })) ctx.notModified();
  return config;
});

export const dynamic = 'force-dynamic';
