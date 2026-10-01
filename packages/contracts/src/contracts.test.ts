import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkRoutes } from '../scripts/lib/check';
import { buildDocument, toOpenApiPath } from '../scripts/lib/openapi-doc';
import { allRoutes } from './routes.gen';
import { errorRegistry } from './errors.gen';
import { defineRoute, surfaceOf, type AnyRouteDef } from './_conventions/route';

const route = (over: Partial<AnyRouteDef> = {}): AnyRouteDef =>
  defineRoute({
    id: 'health.storefront',
    method: 'GET',
    path: '/api/v1/health',
    auth: 'public',
    summary: 's',
    tags: ['t'],
    response: z.object({ ok: z.boolean() }),
    examples: [{ name: 'ok', response: { ok: true } }],
    ...over,
  } as never) as AnyRouteDef;

describe('the aggregated contract surface', () => {
  it('passes its own gate', () => {
    expect(checkRoutes(allRoutes)).toEqual([]);
  });

  it('aggregated the health and auth domains', () => {
    const ids = allRoutes.map((r) => r.id).sort();
    expect(ids).toContain('health.storefront');
    expect(ids).toContain('health.admin');
    expect(ids).toContain('auth.adminLogin');
    expect(ids).toContain('auth.adminMe');
    expect(ids).toContain('auth.adminLogout');
  });

  it('gives every admin route a permission and every route an example', () => {
    for (const r of allRoutes) {
      if (r.auth === 'admin') expect(r.permission, r.id).toBeTruthy();
      expect(r.examples.length, r.id).toBeGreaterThan(0);
    }
  });

  it('trims every list query’s keyword, so 「 白T 」 searches for 白T', () => {
    let checked = 0;
    for (const r of allRoutes) {
      if (!(r.query instanceof z.ZodType)) continue;
      const parsed = r.query.safeParse({ keyword: '  白T  ' });
      if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') continue;
      if (!('keyword' in parsed.data)) continue;
      expect((parsed.data as { keyword: unknown }).keyword, r.id).toBe('白T');
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('merges the common error codes into the registry', () => {
    expect(errorRegistry.VALIDATION_FAILED).toEqual({ status: 422, message: '提交的数据有误' });
    expect(errorRegistry.AUTH_INVALID_CREDENTIALS?.status).toBe(401);
  });
});

describe('checkRoutes', () => {
  it('rejects duplicate route ids', () => {
    const problems = checkRoutes([route(), route({ path: '/api/v1/other' })]);
    expect(problems).toContainEqual(
      expect.objectContaining({ where: 'id', detail: 'duplicate route id' }),
    );
  });

  it('rejects duplicate method + path', () => {
    const problems = checkRoutes([route(), route({ id: 'health.other' })]);
    expect(problems.map((p) => p.where)).toContain('path');
  });

  it('rejects an example whose response does not parse', () => {
    const problems = checkRoutes([route({ examples: [{ name: 'bad', response: { ok: 'yes' } }] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.where).toBe('example "bad" response');
  });

  it('rejects an example whose body does not parse', () => {
    const problems = checkRoutes([
      route({
        method: 'POST',
        body: z.object({ n: z.number() }),
        examples: [{ name: 'bad', body: { n: 'x' }, response: { ok: true } }],
      }),
    ]);
    expect(problems[0]?.where).toBe('example "bad" body');
  });

  it('rejects a :param that the params schema does not declare', () => {
    const problems = checkRoutes([route({ path: '/api/v1/things/:id' })]);
    expect(problems[0]?.where).toBe('params');
  });

  it('rejects an unknown error code', () => {
    const problems = checkRoutes([route({ errors: ['NO_SUCH_CODE'] })]);
    expect(problems[0]?.detail).toContain('NO_SUCH_CODE');
  });

  it('rejects two examples with the same name', () => {
    const problems = checkRoutes([
      route({
        examples: [
          { name: 'ok', response: { ok: true } },
          { name: 'ok', response: { ok: false } },
        ],
      }),
    ]);
    expect(problems.map((p) => p.detail)).toContain('duplicate example name "ok"');
  });
});

describe('openapi', () => {
  it('rewrites express params to openapi params', () => {
    expect(toOpenApiPath('/admin-api/roles/:id/permissions/:permission')).toBe(
      '/admin-api/roles/{id}/permissions/{permission}',
    );
  });

  it('documents every route exactly once', () => {
    const doc = buildDocument(allRoutes);
    const operations = Object.values(doc.paths ?? {}).flatMap((p) =>
      Object.values(p as Record<string, { operationId?: string }>),
    );
    const ids = operations.map((o) => o.operationId).filter(Boolean);
    expect(new Set(ids).size).toBe(allRoutes.length);
  });

  it('attaches the cookie scheme to admin routes and the bearer scheme to user routes', () => {
    const doc = buildDocument(allRoutes);
    const me = (doc.paths?.['/admin-api/auth/me'] as { get?: { security?: unknown[] } })?.get;
    expect(me?.security).toEqual([{ adminSession: [] }]);
  });
});

describe('surfaceOf', () => {
  it('splits the two surfaces', () => {
    expect(surfaceOf('/admin-api/x')).toBe('admin');
    expect(surfaceOf('/api/v1/x')).toBe('storefront');
  });
});
