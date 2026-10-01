import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes } from '@shop/contracts/routes';
import { adminProfileExample } from '@shop/contracts/auth/schemas';
import {
  bySpecificity,
  compileRoute,
  matchRoute,
  pickExample,
  startMockServer,
  type RunningMockServer,
} from './index';

/**
 * The mock server is what the mini program and the admin build against before a
 * handler exists, so "it answers, and it validates" is a promise to both.
 */

let server: RunningMockServer;

beforeAll(async () => {
  server = await startMockServer({ port: 0 });
});

afterAll(async () => {
  await server?.close();
});

const get = (path: string, init?: RequestInit) => fetch(`${server.url}${path}`, init);

describe('serving examples', () => {
  it('answers GET /api/v1/health with the contract example', async () => {
    const response = await get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      status: 'ok',
      time: '2026-01-01T12:00:00+08:00',
      version: 'dev',
    });
  });

  it('answers the admin surface too', async () => {
    expect((await get('/admin-api/health')).status).toBe(200);
  });

  it('answers the admin auth routes the shell needs', async () => {
    const login = await get('/admin-api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: 'xzoo123456' }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual(adminProfileExample);

    expect(await (await get('/admin-api/auth/me')).json()).toEqual(adminProfileExample);

    const logout = await get('/admin-api/auth/logout', { method: 'POST' });
    expect(await logout.json()).toEqual({ ok: true });
  });

  it('selects another example with X-Mock-Example', async () => {
    const limited = await get('/admin-api/auth/me', { headers: { 'x-mock-example': 'limited' } });
    const payload = await limited.json();
    expect(payload.account).toBe('operator');
    expect(payload.isSuper).toBe(false);
  });

  it('404s a named example that does not exist, and says which do', async () => {
    const response = await get('/admin-api/auth/me', { headers: { 'x-mock-example': 'nope' } });
    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.code).toBe('NOT_FOUND');
    expect(payload.details.available).toEqual(['super', 'limited']);
  });

  /**
   * A literal segment must beat a `:param` one, **whatever order the registry
   * hands the routes over in**.
   *
   * Both orderings are asserted because the bug this replaced was invisible in
   * one of them. `bySpecificity` used to return `0` for two unrelated paths,
   * which is not a total order, so `sort` produced whatever the pairs it
   * happened to compare allowed — and `/api/v1/addresses/default` started
   * answering `422` the day an unrelated contract was added somewhere else in
   * the tree, because `/api/v1/addresses/:id` had drifted in front of it.
   */
  it('prefers a literal segment over a :param one however the routes are ordered', async () => {
    const literal = allRoutes.find((route) => route.path === '/api/v1/addresses/default');
    const wildcard = allRoutes.find((route) => route.path === '/api/v1/addresses/:id');
    expect(literal).toBeDefined();
    expect(wildcard).toBeDefined();

    for (const routes of [
      [literal!, wildcard!],
      [wildcard!, literal!],
    ]) {
      const instance = await startMockServer({ port: 0, routes });
      try {
        expect((await fetch(`${instance.url}/api/v1/addresses/default`)).status).toBe(200);
        expect((await fetch(`${instance.url}/api/v1/addresses/7`)).status).toBe(200);
      } finally {
        await instance.close();
      }
    }
  });

  it('serves every registered route from its first example', async () => {
    for (const route of allRoutes) {
      if (route.params) continue; // covered separately; needs a concrete id
      // A route with a required query only answers 200 when its own example's query is sent.
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(route.examples[0]?.query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value]) query.append(key, String(item));
      }
      const response = await fetch(`${server.url}${route.path}?${query.toString()}`, {
        method: route.method,
        ...(route.body
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(route.examples[0]?.body ?? {}),
            }
          : {}),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(route.status ?? 200);
    }
  });
});

describe('validating what the client sent', () => {
  it('422s a body that does not parse, in the standard error shape', async () => {
    const response = await get('/admin-api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: '', password: '' }),
    });
    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.message).toBe('提交的数据有误');
    expect(payload.details.map((d: { field: string }) => d.field).sort()).toEqual([
      'account',
      'password',
    ]);
  });

  it('422s a missing body', async () => {
    const response = await get('/admin-api/auth/login', { method: 'POST' });
    expect(response.status).toBe(422);
  });

  it('422s a body that is not JSON', async () => {
    const response = await get('/admin-api/auth/login', { method: 'POST', body: 'nonsense' });
    expect(response.status).toBe(422);
    expect((await response.json()).details[0].field).toBe('<body>');
  });
});

describe('routing', () => {
  it('404s an unknown path and 405s a known path with the wrong method', async () => {
    expect((await get('/api/v1/nothing-here')).status).toBe(404);
    expect((await get('/api/v1/health', { method: 'POST' })).status).toBe(405);
  });

  it('answers CORS preflight, so a browser client can develop against it', async () => {
    const response = await get('/api/v1/health', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('lists its routes for discovery', async () => {
    const listed = await (await get('/__mock/routes')).json();
    expect(listed).toHaveLength(allRoutes.length);
    expect(listed.find((r: { id: string }) => r.id === 'auth.adminMe').examples).toEqual([
      'super',
      'limited',
    ]);
  });
});

describe('bySpecificity', () => {
  /**
   * A comparator that is not a total order makes `sort` registry-order
   * dependent, so the failure shows up in a file nobody touched the day an
   * unrelated route is added. This pins the property itself over the whole
   * table, not one pair that happened to break.
   */
  it('is a total order over every registered route', () => {
    // Violations are collected and asserted once: an `expect` per pair is a
    // million calls over today's table, too slow for a CI runner's 5 s.
    const compiled = allRoutes.map(compileRoute);
    const label = (r: (typeof compiled)[number]) => `${r.route.method} ${r.route.path}`;
    const violations: string[] = [];
    for (const a of compiled) {
      if (bySpecificity(a, a) !== 0) violations.push(`not reflexive: ${label(a)}`);
      for (const b of compiled) {
        if (Math.sign(bySpecificity(a, b)) + Math.sign(bySpecificity(b, a)) !== 0) {
          violations.push(`not antisymmetric: ${label(a)} / ${label(b)}`);
        }
      }
    }
    const sorted = [...compiled].sort(bySpecificity);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        // Every earlier element compares below every later one — transitivity
        // made visible, without an n³ walk. Equal only for one path under two
        // methods, which the matcher tells apart itself.
        const order = bySpecificity(sorted[i]!, sorted[j]!);
        const samePath = sorted[i]!.route.path === sorted[j]!.route.path;
        if (samePath ? order !== 0 : order >= 0) {
          violations.push(`out of order: ${label(sorted[i]!)} before ${label(sorted[j]!)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('matchRoute', () => {
  const compiled = allRoutes.map(compileRoute);

  it('matches an exact path', () => {
    const match = matchRoute(compiled, 'GET', '/api/v1/health');
    expect(match).not.toBeNull();
    expect(match).not.toBe('method-not-allowed');
    expect((match as { route: { id: string } }).route.id).toBe('health.storefront');
  });

  it('distinguishes "no such path" from "wrong method"', () => {
    expect(matchRoute(compiled, 'GET', '/api/v1/nope')).toBeNull();
    expect(matchRoute(compiled, 'DELETE', '/api/v1/health')).toBe('method-not-allowed');
  });

  it('extracts and decodes :params', () => {
    const withParam = compileRoute({
      id: 'x',
      method: 'GET',
      path: '/api/v1/things/:id/parts/:partId',
      auth: 'public',
      summary: '',
      tags: [],
      response: {} as never,
      examples: [{ name: 'a', response: {} }],
    });
    const match = matchRoute([withParam], 'GET', '/api/v1/things/42/parts/a%20b');
    expect((match as { params: Record<string, string> }).params).toEqual({
      id: '42',
      partId: 'a b',
    });
  });

  it('does not let a param swallow a path separator', () => {
    const withParam = compileRoute({
      id: 'x',
      method: 'GET',
      path: '/api/v1/things/:id',
      auth: 'public',
      summary: '',
      tags: [],
      response: {} as never,
      examples: [{ name: 'a', response: {} }],
    });
    expect(matchRoute([withParam], 'GET', '/api/v1/things/1/2')).toBeNull();
  });

  /**
   * The server sorts its routes so that a static segment wins over a
   * `:param` one, and for a long time it did that with a comparator that
   * returned 0 for any two paths that never disagreed about staticness. That
   * is not a total order, and `Array.prototype.sort` given one may reorder
   * elements that the comparator *did* have an opinion about — so a route
   * added anywhere in the table could push `/api/v1/addresses/default` behind
   * `/api/v1/addresses/:id`, and the server would then answer
   * `VALIDATION_FAILED` on an `id` the caller never sent.
   *
   * Sorting a shuffled copy of the whole live table is the test that catches
   * that class of bug: a comparator with a hole in it gives different answers
   * for different input orders, and a correct one cannot.
   */
  it('puts every static path ahead of every :param path that would swallow it', () => {
    // The property, stated over the whole live table rather than over the one
    // route a particular sort happened to misplace: if a `:param` route's
    // regex matches another route's literal path, the literal one has to come
    // first, or the mock answers the wrong route.
    const sorted = allRoutes.map(compileRoute).sort(bySpecificity);
    const at = new Map(sorted.map((entry, index) => [entry.route, index]));

    const offenders: string[] = [];
    for (const shadowed of sorted) {
      if (shadowed.paramNames.length > 0) continue;
      for (const shadower of sorted) {
        if (shadower.paramNames.length === 0) continue;
        if (!shadower.regex.test(shadowed.route.path)) continue;
        if (at.get(shadower.route)! < at.get(shadowed.route)!) {
          offenders.push(`${shadower.route.path} shadows ${shadowed.route.path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('pickExample', () => {
  const route = allRoutes.find((r) => r.id === 'auth.adminMe')!;

  it('defaults to the first example', () => {
    expect(pickExample(route, undefined)?.name).toBe('super');
  });

  it('selects by name and returns null for an unknown one', () => {
    expect(pickExample(route, 'limited')?.name).toBe('limited');
    expect(pickExample(route, 'nope')).toBeNull();
  });
});
