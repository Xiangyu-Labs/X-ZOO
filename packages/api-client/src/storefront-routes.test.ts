/**
 * The generated page catalogue is a faithful, zod-free copy of the contracts'
 * `storefrontRoutes` (docs/mini/pages.md §3). The contracts are loaded here,
 * in a test, which is the only place besides `gen` they may be.
 */
import * as contracts from '@shop/contracts/system/storefront-routes';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { storefrontRoutes, type StorefrontRoute, type StorefrontRouteKey } from './index';

const keys = Object.keys(storefrontRoutes) as StorefrontRouteKey[];

describe('storefrontRoutes (generated)', () => {
  it('has the contracts keys, in the same order', () => {
    expect(keys).toEqual(contracts.storefrontRouteKeys);
    expectTypeOf<StorefrontRouteKey>().toEqualTypeOf<contracts.StorefrontRouteKey>();
    expectTypeOf<StorefrontRoute>().toEqualTypeOf<contracts.StorefrontRoute>();
  });

  it.each(contracts.storefrontRouteKeys)('%s matches the contract', (key) => {
    const def = contracts.storefrontRouteDef(key);
    const entry = storefrontRoutes[key];
    expect(entry.path).toBe(def.path);
    expect(entry.tab).toBe(def.tab === true);
    expect(entry.share).toBe(def.share);
    if (def.params instanceof z.ZodObject)
      expect(entry.params).toEqual(Object.keys(def.params.shape));
  });

  it('lists both of `order`’s alternative params', () => {
    expect(storefrontRoutes.order.params).toEqual(['id', 'outTradeNo']);
    expect(storefrontRoutes.home.params).toEqual([]);
  });

  it('is plain data: every value is a string, a boolean or a string array', () => {
    expect(JSON.parse(JSON.stringify(storefrontRoutes))).toEqual(storefrontRoutes);
  });
});
