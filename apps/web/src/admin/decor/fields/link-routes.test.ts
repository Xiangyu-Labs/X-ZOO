import { ROUTE_LINK_LABELS } from '@shop/contracts/decor/constants';
import { linkTarget } from '@shop/contracts/decor/link';
import { unwrapSchema } from '@shop/contracts/decor/meta';
import {
  storefrontRouteDef,
  type StorefrontRouteKey,
} from '@shop/contracts/system/storefront-routes';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  LINK_ROUTES,
  LINK_ROUTE_KEYS,
  catalogueLinkableKeys,
  checkRoute,
  isParamRequired,
} from './link-routes';

function paramShape(route: StorefrontRouteKey): Record<string, z.ZodType> {
  const params = storefrontRouteDef(route).params as unknown as {
    shape?: Record<string, z.ZodType>;
  };
  return params.shape ?? {};
}

describe('the link picker covers the route catalogue', () => {
  it('offers exactly the linkable routes', () => {
    expect([...LINK_ROUTE_KEYS].sort()).toEqual([...catalogueLinkableKeys()].sort());
  });

  it('keeps the catalogue labels of the param-less routes', () => {
    for (const [route, label] of Object.entries(ROUTE_LINK_LABELS)) {
      expect(LINK_ROUTES[route as keyof typeof LINK_ROUTES]?.label).toBe(label);
    }
  });

  it.each(LINK_ROUTE_KEYS)(
    '%s: a control for every param, and a label for every enum value',
    (route) => {
      const shape = paramShape(route);
      const spec = LINK_ROUTES[route];
      expect(Object.keys(spec.params).sort()).toEqual(Object.keys(shape).sort());
      for (const [param, control] of Object.entries(spec.params)) {
        if (control.kind !== 'enum') continue;
        const inner = unwrapSchema(shape[param]!).schema as unknown as { options: string[] };
        expect(Object.keys(control.options).sort()).toEqual([...inner.options].sort());
      }
    },
  );
});

describe('checkRoute', () => {
  it('asks for a required param, naming it', () => {
    expect(checkRoute('product', {})).toEqual({ ok: false, issue: '请选择商品' });
    expect(isParamRequired('product', 'id')).toBe(true);
    expect(isParamRequired('productList', 'categoryId')).toBe(false);
  });

  it('drops empty optional params and yields a route a link may store', () => {
    const result = checkRoute('productList', { categoryId: '12', keyword: '' });
    expect(result).toEqual({
      ok: true,
      route: { route: 'productList', params: { categoryId: '12' } },
    });
    if (!result.ok) return;
    expect(linkTarget.safeParse({ kind: 'route', to: result.route }).success).toBe(true);
  });

  it('refuses a route that is not linkable and a param that does not parse', () => {
    expect(checkRoute('checkout', {})).toMatchObject({ ok: false });
    expect(checkRoute('featured', { tab: 'nope' })).toMatchObject({ ok: false });
  });
});
