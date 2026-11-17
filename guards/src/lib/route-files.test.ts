import { describe, expect, it } from 'vitest';
import {
  boundContracts,
  boundContractsByMethod,
  ctxRouteIds,
  declaresForceDynamic,
  exportedMethods,
  isMutating,
  methodBodies,
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

describe('boundContracts', () => {
  it('reads the contract each handle() call names', () => {
    const source = [
      'export const GET = handle(couponAdminList, (ctx) => list(ctx));',
      'export const POST = handle(couponAdminCreate, (ctx) => create(ctx));',
    ].join('\n');
    expect(boundContracts(source)).toEqual(['couponAdminList', 'couponAdminCreate']);
  });

  it('does not count a handle() that only appears in a comment', () => {
    const source = [
      '// handle(couponAdminList, …) used to be here',
      'export const GET = handle(orderAdminList, (ctx) => list(ctx));',
    ].join('\n');
    expect(boundContracts(source)).toEqual(['orderAdminList']);
  });
});

describe('methodBodies', () => {
  const twoWrites = [
    'export const PUT = handle(userLabelUpdate, async (ctx, { params, body }) => {',
    '  ctx.audit(`user-label:${params.id}`);',
    '  return update(ctx, params, body);',
    '});',
    'export const DELETE = handle(userLabelDelete, async (ctx, { params }) => {',
    '  return remove(ctx, params);',
    '});',
  ].join('\n');

  it('slices each exported method, so a sibling’s audit does not count', () => {
    const bodies = methodBodies(twoWrites);
    expect(Object.keys(bodies).sort()).toEqual(['DELETE', 'PUT']);
    expect(namesAuditTarget(bodies.PUT ?? '')).toBe(true);
    expect(namesAuditTarget(bodies.DELETE ?? '')).toBe(false);
  });

  it('associates each method with its own handle() binding', () => {
    expect(boundContractsByMethod(twoWrites)).toEqual({
      PUT: 'userLabelUpdate',
      DELETE: 'userLabelDelete',
    });
  });
});

describe('ctxRouteIds', () => {
  it('reads the route id a bare handler passes to ctxFor', () => {
    expect(ctxRouteIds("verifyUrl(ctxFor(request, 'wechatOa.webhookVerify'), query);")).toEqual([
      'wechatOa.webhookVerify',
    ]);
  });
});
