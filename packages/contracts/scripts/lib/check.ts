/**
 * The contract gate. Fails the build when:
 *
 *  - two routes share an `id`, or a `method + path`;
 *  - a route declares an error code that no `errors.ts` defines;
 *  - an example's params / query / body / response does not parse against the
 *    route's schemas;
 *  - a path declares `:param` placeholders that the `params` schema does not
 *    cover (or vice versa);
 *  - two examples of one route share a name (the mock server selects by name).
 *
 * Every route is a promise to the mini program and the admin shell, both of which
 * can develop against the mock server before any handler exists — so an example
 * that does not parse is a broken promise, not a nit.
 *
 * Run: `pnpm --filter @shop/contracts check:examples`
 */
import { z } from 'zod';
import { errorRegistry } from '../../src/errors.gen';
import type { AnyRouteDef } from '../../src/_conventions/route';

export interface Problem {
  routeId: string;
  where: string;
  detail: string;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
    .join('; ');
}

function checkOne(route: AnyRouteDef, problems: Problem[]): void {
  const declared = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  const shape = route.params instanceof z.ZodObject ? Object.keys(route.params.shape) : undefined;
  if (declared.length > 0 && !shape) {
    problems.push({
      routeId: route.id,
      where: 'params',
      detail: `path declares ${declared.join(', ')} but the route has no params schema`,
    });
  }
  if (shape) {
    for (const name of declared) {
      if (!shape.includes(name)) {
        problems.push({
          routeId: route.id,
          where: 'params',
          detail: `:${name} missing from schema`,
        });
      }
    }
    for (const name of shape) {
      if (!declared.includes(name)) {
        problems.push({ routeId: route.id, where: 'params', detail: `${name} is not in the path` });
      }
    }
  }

  for (const code of route.errors ?? []) {
    if (!errorRegistry[code]) {
      problems.push({ routeId: route.id, where: 'errors', detail: `unknown error code ${code}` });
    }
  }

  const seenNames = new Set<string>();
  for (const example of route.examples) {
    if (seenNames.has(example.name)) {
      problems.push({
        routeId: route.id,
        where: 'examples',
        detail: `duplicate example name "${example.name}"`,
      });
    }
    seenNames.add(example.name);

    const at = `example "${example.name}"`;
    if (route.params) {
      const r = route.params.safeParse(example.params ?? {});
      if (!r.success)
        problems.push({ routeId: route.id, where: `${at} params`, detail: formatIssues(r.error) });
    }
    if (route.query) {
      const r = route.query.safeParse(example.query ?? {});
      if (!r.success)
        problems.push({ routeId: route.id, where: `${at} query`, detail: formatIssues(r.error) });
    }
    if (route.body) {
      const r = route.body.safeParse(example.body);
      if (!r.success)
        problems.push({ routeId: route.id, where: `${at} body`, detail: formatIssues(r.error) });
    } else if (example.body !== undefined) {
      problems.push({ routeId: route.id, where: `${at} body`, detail: 'route takes no body' });
    }
    const r = route.response.safeParse(example.response);
    if (!r.success)
      problems.push({ routeId: route.id, where: `${at} response`, detail: formatIssues(r.error) });
  }
}

/** Pure so the unit test can call it without touching the process. */
export function checkRoutes(routes: readonly AnyRouteDef[]): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map<string, AnyRouteDef>();
  const byEndpoint = new Map<string, AnyRouteDef>();

  for (const route of routes) {
    if (byId.has(route.id)) {
      problems.push({ routeId: route.id, where: 'id', detail: 'duplicate route id' });
    }
    byId.set(route.id, route);

    const endpoint = `${route.method} ${route.path}`;
    const clash = byEndpoint.get(endpoint);
    if (clash) {
      problems.push({
        routeId: route.id,
        where: 'path',
        detail: `${endpoint} already defined by ${clash.id}`,
      });
    }
    byEndpoint.set(endpoint, route);

    checkOne(route, problems);
  }
  return problems;
}
