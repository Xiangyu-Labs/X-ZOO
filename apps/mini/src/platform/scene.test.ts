import { describe, expect, it } from 'vitest';
// The server's encoder, at runtime, is the point of this test (it never ships: a test file).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  encodeScene,
  storefrontRouteDef,
  storefrontRouteKeys,
  toMiniPath,
  type StorefrontRoute,
} from '@shop/contracts/system/storefront-routes';
import { storefrontRoutes } from '@shop/api-client/routes';
import { decodeEnter } from './launch';
import { toPath } from './nav';

/**
 * A 小程序码 opens its page with `options.scene` (C11): the server encodes the route's params with
 * `encodeScene`, WeChat hands the page the scene URI-encoded, and the client decodes it locally.
 * Checked end to end for every key the catalogue lets the server draw a code for.
 */
const MINI_CODE_KEYS = storefrontRouteKeys.filter((key) => storefrontRouteDef(key).miniCode);

/** The longest id the database hands out (bigint), to keep the scene's 32 bytes honest. */
const LONG_ID = '9223372036854775807';

function sampleRoute(key: (typeof storefrontRouteKeys)[number]): StorefrontRoute {
  const names: readonly string[] = storefrontRoutes[key].params;
  const params = Object.fromEntries(names.map((name) => [name, LONG_ID]));
  return { route: key, params } as StorefrontRoute;
}

describe('小程序码 scene → route', () => {
  it('covers the keys the brief names', () => {
    expect([...MINI_CODE_KEYS].sort()).toEqual(
      [
        'article',
        'couponCenter',
        'groupbuy',
        'groupbuyTeam',
        'home',
        'page',
        'presale',
        'product',
      ].sort(),
    );
  });

  it.each(MINI_CODE_KEYS)('%s: the code opens the same route', (key) => {
    const route = sampleRoute(key);
    const scene = encodeScene(route);
    const { path } = storefrontRouteDef(key);
    // WeChat launches the code's `page` with the scene URI-encoded.
    const launched = decodeEnter({
      path,
      query: { scene: encodeURIComponent(scene) },
      scene: 1047,
    });
    expect(launched.route).toEqual(route);
    expect(launched.isTimelineSinglePage).toBe(false);
    // …and a raw (already decoded) scene reads the same.
    expect(decodeEnter({ path: `/${path}`, query: { scene }, scene: 1047 }).route).toEqual(route);
  });

  it.each(MINI_CODE_KEYS)('%s: a share path and the server path agree', (key) => {
    const route = sampleRoute(key);
    expect(toPath(route)).toBe(`/${toMiniPath(route)}`);
  });
});
