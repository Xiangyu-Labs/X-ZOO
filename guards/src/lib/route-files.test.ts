import { describe, expect, it } from 'vitest';
import {
  declaresForceDynamic,
  exportedMethods,
  isMutating,
  namesAuditTarget,
  paramsOf,
  shapeOf,
  urlOfRouteFile,
} from './route-files';

describe('urlOfRouteFile', () => {
  it('turns a folder into a URL', () => {
    expect(urlOfRouteFile('admin-api/coupons/[id]/status/route.ts')).toBe(
      '/admin-api/coupons/:id/status',
    );
  });

  it('skips a route group and a private folder', () => {
    expect(urlOfRouteFile('api/(public)/_lib/products/route.ts')).toBe('/api/products');
  });

  it('keeps a catch-all recognisable', () => {
    expect(urlOfRouteFile('api/files/[...path]/route.ts')).toBe('/api/files/:...path');
  });
});

describe('shapeOf', () => {
  it('erases parameter names so two spellings of one URL compare equal', () => {
    expect(shapeOf('/admin-api/coupons/:couponId/grants/:userId')).toBe(
      shapeOf('/admin-api/coupons/:id/grants/:uid'),
    );
  });

  it('drops a trailing slash', () => {
    expect(shapeOf('/api/v1/cart/')).toBe('/api/v1/cart');
  });
});

describe('paramsOf', () => {
  it('lists the parameter names in order', () => {
    expect(paramsOf('/admin-api/orders/:orderId/items/:itemId')).toEqual(['orderId', 'itemId']);
  });
});

describe('exportedMethods', () => {
  it('reads const, function and async function exports', () => {
    const source = [
      'export const GET = handle(listCoupons, fn);',
      'export async function POST(request: Request) {}',
      'export function DELETE() {}',
    ].join('\n');
    expect(exportedMethods(source)).toEqual(['GET', 'POST', 'DELETE']);
  });

  it('does not count a method that is only mentioned', () => {
    expect(exportedMethods('// PUT is served by the [id] route\nexport const GET = 1;')).toEqual([
      'GET',
    ]);
  });
});

describe('the small predicates', () => {
  it('knows which verbs write', () => {
    expect(['POST', 'PUT', 'PATCH', 'DELETE'].every(isMutating)).toBe(true);
    expect(isMutating('GET')).toBe(false);
  });

  it('recognises the force-dynamic export in either quoting', () => {
    expect(declaresForceDynamic("export const dynamic = 'force-dynamic';")).toBe(true);
    expect(declaresForceDynamic('export const dynamic = "force-dynamic";')).toBe(true);
    expect(declaresForceDynamic('export const dynamic = mode;')).toBe(false);
  });

  it('recognises an audit target, and does not accept a comment about one', () => {
    expect(namesAuditTarget('  ctx.audit({ coupon: coupon.id });')).toBe(true);
    expect(namesAuditTarget('// ctx.audit is written by handle()')).toBe(false);
    expect(namesAuditTarget('/* no ctx.audit(target) here: nothing is written */')).toBe(false);
    expect(namesAuditTarget('const audited = true;')).toBe(false);
  });
});
