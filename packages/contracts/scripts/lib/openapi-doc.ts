/**
 * Turns `allRoutes` into an OpenAPI 3.1 document.
 *
 * The document is generated, gitignored and rebuilt by `pnpm gen`; the merge
 * gate diffs it rather than reviewing it by hand. Two surfaces share one
 * document — they are tagged and their paths never collide.
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { errorRegistry } from '../../src/errors.gen';
import { errorBody } from '../../src/_conventions/errors';
import { surfaceOf, type AnyRouteDef } from '../../src/_conventions/route';

/** `/admin-api/roles/:id/permissions` -> `/admin-api/roles/{id}/permissions` */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function statusesFor(route: AnyRouteDef): number[] {
  const codes = new Set<number>();
  for (const code of route.errors ?? []) {
    const spec = errorRegistry[code];
    if (!spec) throw new Error(`${route.id}: unknown error code ${code}`);
    codes.add(spec.status);
  }
  codes.add(422); // every route validates its input
  if (route.auth !== 'public' && route.auth !== 'webhook') codes.add(401);
  if (route.permission) codes.add(403);
  codes.add(500);
  return [...codes].sort((a, b) => a - b);
}

export function buildDocument(routes: readonly AnyRouteDef[]) {
  const registry = new OpenAPIRegistry();

  const adminSession = registry.registerComponent('securitySchemes', 'adminSession', {
    type: 'apiKey',
    in: 'cookie',
    name: 'admin_session',
  });
  const userBearer = registry.registerComponent('securitySchemes', 'userBearer', {
    type: 'http',
    scheme: 'bearer',
  });

  for (const route of routes) {
    const security =
      route.auth === 'admin'
        ? [{ [adminSession.name]: [] }]
        : route.auth === 'user' || route.auth === 'user-optional'
          ? [{ [userBearer.name]: [] }]
          : [];

    const status = route.status ?? 200;
    const responses: Record<string, unknown> = {
      [status]:
        status === 204
          ? { description: '无内容' }
          : {
              description: route.summary,
              content: { 'application/json': { schema: route.response } },
            },
    };
    for (const errStatus of statusesFor(route)) {
      responses[errStatus] = {
        description: '错误',
        content: { 'application/json': { schema: errorBody } },
      };
    }

    registry.registerPath({
      operationId: route.id,
      method: route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete',
      path: toOpenApiPath(route.path),
      summary: route.summary,
      description: [
        `surface: ${surfaceOf(route.path)}`,
        `auth: ${route.auth}`,
        route.permission ? `permission: \`${route.permission}\`` : undefined,
        route.errors?.length ? `errors: ${route.errors.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
      tags: [...route.tags],
      security,
      request: {
        ...(route.params ? { params: route.params as z.ZodObject } : {}),
        ...(route.query ? { query: route.query as z.ZodObject } : {}),
        ...(route.body
          ? { body: { content: { 'application/json': { schema: route.body } } } }
          : {}),
      },
      responses: responses as never,
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'X-ZOO 商城 API',
      version: '1.0.0',
      description:
        '由 packages/contracts 的 defineRoute 生成，`/admin-api/*` 为后台、`/api/v1/*` 为商城端。',
    },
    servers: [{ url: '/' }],
  });
}
