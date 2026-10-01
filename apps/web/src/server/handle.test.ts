import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineRoute } from '@shop/contracts/conventions';
import {
  DomainError,
  fixedClock,
  memoryQueue,
  memoryStorage,
  silentLogger,
} from '@shop/core/kernel';
import { resetUserLookup } from '@shop/core/auth';

// One live API token, acting as a super admin; every other bearer is unknown.
vi.mock('@shop/core/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shop/core/auth')>();
  return {
    ...actual,
    resolveApiToken: async (_deps: unknown, token: string) =>
      token === 'shp_live-test-token'
        ? {
            tokenId: 9,
            tokenName: '助手',
            adminId: 1,
            account: 'admin',
            isSuper: true,
            permissions: [],
          }
        : null,
  };
});
import { toApiError } from '../admin/api/errors';
import { ADMIN_COOKIE, checkCsrf, handle, readCookie, searchParamsToObject } from './handle';
import type { Container } from './container';
import type { Env } from './env';

/**
 * `handle()` is exercised with plain Web `Request` objects — no Next runtime,
 * no server, no database. Everything it does that is worth testing is a pure
 * function of the request plus the container, and a fake container is enough.
 */

const env: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  REDIS_URL: 'redis://unused',
  UPLOADS_DIR: '/tmp/uploads',
  UPLOADS_PUBLIC_PREFIX: '/uploads',
  APP_ORIGIN: 'https://shop.example',
  EXTRA_ALLOWED_ORIGINS: [],
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  VALIDATE_RESPONSES: true,
  DB_POOL_MAX: 1,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

interface FakeSession {
  adminId: number;
  account: string;
  name: string;
  avatar: string | null;
  isSuper: boolean;
  permissions: string[];
  passwordVersion: number;
  createdAt: number;
  sessionId: string;
  ttlMs: number;
  remember?: boolean;
}

let adminSessions: Map<string, FakeSession>;
let userSessions: Map<string, { sessionId: number; userId: number; platform: string }>;
let audits: unknown[];

function fakeContainer(overrides: Partial<Container> = {}): Container {
  return {
    env,
    dbHandle: {} as never,
    db: {
      // `handle()` only touches the db to write an audit row.
      insert: () => ({
        values: async (row: unknown) => {
          audits.push(row);
        },
      }),
    } as never,
    redis: {} as never,
    clock: fixedClock('2026-01-01T00:00:00.000Z'),
    logger: silentLogger(),
    queue: memoryQueue(),
    storage: memoryStorage(),
    config: {} as never,
    adminAuth: {
      resolve: async (token: string) => adminSessions.get(token) ?? null,
    } as never,
    userSessions: {
      resolve: async (_ctx: unknown, token: string) => userSessions.get(token) ?? null,
    } as never,
    close: async () => {},
    ...overrides,
  };
}

const okRoute = defineRoute({
  id: 'test.ok',
  method: 'GET',
  path: '/api/v1/things',
  auth: 'public',
  summary: 'ok',
  tags: ['test'],
  query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
  response: z.object({ page: z.number() }),
  examples: [{ name: 'ok', response: { page: 1 } }],
});

const paramRoute = defineRoute({
  id: 'test.param',
  method: 'GET',
  path: '/api/v1/things/:id',
  auth: 'public',
  summary: 'param',
  tags: ['test'],
  params: z.object({ id: z.string().regex(/^[1-9]\d*$/) }),
  response: z.object({ id: z.string() }),
  examples: [{ name: 'ok', params: { id: '1' }, response: { id: '1' } }],
});

const bodyRoute = defineRoute({
  id: 'test.body',
  method: 'POST',
  path: '/api/v1/things',
  auth: 'public',
  summary: 'body',
  tags: ['test'],
  body: z.object({ name: z.string().min(2), count: z.number().int() }),
  response: z.object({ ok: z.boolean() }),
  status: 201,
  examples: [{ name: 'ok', body: { name: 'ab', count: 1 }, response: { ok: true } }],
});

const adminRoute = defineRoute({
  id: 'test.admin',
  method: 'GET',
  path: '/admin-api/things',
  auth: 'admin',
  permission: 'catalog:product:read',
  summary: 'admin',
  tags: ['test'],
  response: z.object({ ok: z.boolean() }),
  examples: [{ name: 'ok', response: { ok: true } }],
});

const adminMutation = defineRoute({
  id: 'test.adminWrite',
  method: 'POST',
  path: '/admin-api/things',
  auth: 'admin',
  permission: 'catalog:product:update',
  summary: 'admin write',
  tags: ['test'],
  body: z.object({ name: z.string() }),
  response: z.object({ ok: z.boolean() }),
  examples: [{ name: 'ok', body: { name: 'a' }, response: { ok: true } }],
});

const userRoute = defineRoute({
  id: 'test.user',
  method: 'GET',
  path: '/api/v1/me',
  auth: 'user',
  summary: 'user',
  tags: ['test'],
  response: z.object({ userId: z.number() }),
  examples: [{ name: 'ok', response: { userId: 1 } }],
});

const optionalRoute = defineRoute({
  id: 'test.optional',
  method: 'GET',
  path: '/api/v1/maybe',
  auth: 'user-optional',
  summary: 'optional',
  tags: ['test'],
  response: z.object({ kind: z.string() }),
  examples: [{ name: 'ok', response: { kind: 'anonymous' } }],
});

const noContentRoute = defineRoute({
  id: 'test.noContent',
  method: 'DELETE',
  path: '/admin-api/things/:id',
  auth: 'admin',
  permission: 'catalog:product:delete',
  summary: 'delete',
  tags: ['test'],
  params: z.object({ id: z.string() }),
  response: z.void(),
  status: 204,
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

const superSession: FakeSession = {
  adminId: 1,
  account: 'admin',
  name: '超管',
  avatar: null,
  isSuper: true,
  permissions: [],
  passwordVersion: 1,
  createdAt: 0,
  sessionId: 'sess-1',
  ttlMs: 8 * 60 * 60 * 1000,
};

const limitedSession: FakeSession = {
  ...superSession,
  adminId: 2,
  account: 'operator',
  isSuper: false,
  permissions: ['catalog:product:read'],
  sessionId: 'sess-2',
};

beforeEach(() => {
  adminSessions = new Map([
    ['good-super', superSession],
    ['good-limited', limitedSession],
  ]);
  userSessions = new Map([['user-token', { sessionId: 10, userId: 7, platform: 'h5' }]]);
  audits = [];
  resetUserLookup();
});

const container = () => fakeContainer();

async function body(response: Response): Promise<any> {
  return response.status === 204 ? null : response.json();
}

describe('input parsing', () => {
  it('parses and defaults the query, and passes it to the handler', async () => {
    const GET = handle(okRoute, async (_ctx, { query }) => ({ page: query.page }), {
      container: container(),
    });
    const response = await GET(new Request('https://shop.example/api/v1/things'));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ page: 1 });
  });

  it('returns 422 VALIDATION_FAILED with field details for a bad query', async () => {
    const GET = handle(okRoute, async () => ({ page: 1 }), { container: container() });
    const response = await GET(new Request('https://shop.example/api/v1/things?page=zero'));
    expect(response.status).toBe(422);
    const payload = await body(response);
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.message).toBe('提交的数据有误');
    expect(payload.details[0].field).toBe('query.page');
  });

  it('awaits the params promise Next hands it', async () => {
    const GET = handle(paramRoute, async (_ctx, { params }) => ({ id: params.id }), {
      container: container(),
    });
    const response = await GET(new Request('https://shop.example/api/v1/things/42'), {
      params: Promise.resolve({ id: '42' }),
    });
    expect(await body(response)).toEqual({ id: '42' });
  });

  it('rejects a param that does not match its schema', async () => {
    const GET = handle(paramRoute, async () => ({ id: 'x' }), { container: container() });
    const response = await GET(new Request('https://shop.example/api/v1/things/abc'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(response.status).toBe(422);
    expect((await body(response)).details[0].field).toBe('params.id');
  });

  it('parses a JSON body and honours the success status', async () => {
    const POST = handle(bodyRoute, async (_ctx, { body: input }) => ({ ok: input.count > 0 }), {
      container: container(),
    });
    const response = await POST(
      new Request('https://shop.example/api/v1/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'ab', count: 2 }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ ok: true });
  });

  it('reports every bad body field at once', async () => {
    const POST = handle(bodyRoute, async () => ({ ok: true }), { container: container() });
    const response = await POST(
      new Request('https://shop.example/api/v1/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'a', count: 'x' }),
      }),
    );
    expect(response.status).toBe(422);
    const details = (await body(response)).details;
    expect(details.map((d: { field: string }) => d.field).sort()).toEqual(['count', 'name']);
  });

  it('sends 422 field errors the admin client maps back onto form fields', async () => {
    const nestedRoute = defineRoute({
      id: 'test.nested',
      method: 'POST',
      path: '/admin-api/things',
      auth: 'public',
      summary: 'nested',
      tags: ['test'],
      body: z.object({
        name: z.string().min(2, '名称至少 2 个字'),
        sku: z.array(z.object({ price: z.string().regex(/^\d+\.\d{2}$/, '价格不合法') })),
      }),
      response: z.object({ ok: z.boolean() }),
      examples: [{ name: 'ok', body: { name: 'ab', sku: [] }, response: { ok: true } }],
    });
    const POST = handle(nestedRoute, async () => ({ ok: true }), { container: container() });
    const response = await POST(
      new Request('https://shop.example/admin-api/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'a', sku: [{ price: '1.00' }, { price: 'x' }] }),
      }),
    );
    expect(response.status).toBe(422);
    expect(toApiError(response.status, await body(response)).fieldErrors).toEqual({
      name: '名称至少 2 个字',
      'sku.1.price': '价格不合法',
    });
  });

  it('rejects a body that is not JSON', async () => {
    const POST = handle(bodyRoute, async () => ({ ok: true }), { container: container() });
    const response = await POST(
      new Request('https://shop.example/api/v1/things', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(422);
    expect((await body(response)).details[0].field).toBe('<body>');
  });
});

describe('authentication', () => {
  it('401s an admin route with no cookie', async () => {
    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });
    const response = await GET(new Request('https://shop.example/admin-api/things'));
    expect(response.status).toBe(401);
    expect((await body(response)).code).toBe('UNAUTHENTICATED');
  });

  it('401s AUTH_SESSION_EXPIRED when the cookie no longer resolves', async () => {
    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });
    const response = await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=stale` },
      }),
    );
    expect(response.status).toBe(401);
    expect((await body(response)).code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('AUTH-011 — slides the cookie of a remembered session with it, and leaves a browser-session one alone', async () => {
    adminSessions.set('remembered', {
      ...superSession,
      remember: true,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });

    const remembered = await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=remembered` },
      }),
    );
    const cookie = remembered.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${ADMIN_COOKIE}=remembered`);
    // Seven days of idle life plus a day in which an expired one still says 登录已过期.
    expect(cookie).toContain(`Max-Age=${8 * 24 * 60 * 60}`);
    expect(cookie).toContain('HttpOnly');

    const plain = await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=good-super` },
      }),
    );
    expect(plain.headers.get('set-cookie')).toBeNull();
  });

  it('does not re-issue a remembered cookie over the one the route clears (logout)', async () => {
    adminSessions.set('remembered', { ...superSession, remember: true, ttlMs: 1000 });
    const GET = handle(
      adminRoute,
      async (ctx) => {
        ctx.clearCookie(ADMIN_COOKIE);
        return { ok: true };
      },
      { container: container() },
    );
    const response = await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=remembered` },
      }),
    );
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).not.toContain(`${ADMIN_COOKIE}=remembered`);
  });

  it('AUTH-012 — refuses an API token on a console-only route, and serves it on the others', async () => {
    const consoleOnlyRoute = defineRoute({
      id: 'test.consoleOnly',
      method: 'POST',
      path: '/admin-api/things/grant',
      auth: 'admin',
      permission: 'catalog:product:read',
      consoleOnly: true,
      summary: 'console only',
      tags: ['test'],
      response: z.object({ ok: z.boolean() }),
      examples: [{ name: 'ok', response: { ok: true } }],
    });
    expect(consoleOnlyRoute.errors).toContain('AUTH_TOKEN_CONSOLE_ONLY');
    let ran = false;
    const POST = handle(
      consoleOnlyRoute,
      async () => {
        ran = true;
        return { ok: true };
      },
      { container: container() },
    );
    const withToken = { headers: { authorization: 'Bearer shp_live-test-token' } };

    const refused = await POST(
      new Request('https://shop.example/admin-api/things/grant', { method: 'POST', ...withToken }),
    );
    expect(refused.status).toBe(403);
    expect((await body(refused)).code).toBe('AUTH_TOKEN_CONSOLE_ONLY');
    expect(ran).toBe(false);

    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });
    const served = await GET(new Request('https://shop.example/admin-api/things', withToken));
    expect(served.status).toBe(200);
  });

  it('builds an admin actor from the session', async () => {
    const seen: unknown[] = [];
    const GET = handle(
      adminRoute,
      async (ctx) => {
        seen.push(ctx.actor);
        return { ok: true };
      },
      { container: container() },
    );
    const response = await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=good-super` },
      }),
    );
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ kind: 'admin', id: 1, isSuper: true, display: 'admin' });
  });

  it('401s a user route without a bearer token, and accepts a good one', async () => {
    const GET = handle(userRoute, async (ctx) => ({ userId: ctx.actor.id ?? 0 }), {
      container: container(),
    });
    expect((await GET(new Request('https://shop.example/api/v1/me'))).status).toBe(401);

    const ok = await GET(
      new Request('https://shop.example/api/v1/me', {
        headers: { authorization: 'Bearer user-token' },
      }),
    );
    expect(await body(ok)).toEqual({ userId: 7 });
  });

  it('user-optional stays anonymous without a token and resolves with one', async () => {
    const GET = handle(optionalRoute, async (ctx) => ({ kind: ctx.actor.kind }), {
      container: container(),
    });
    expect(await body(await GET(new Request('https://shop.example/api/v1/maybe')))).toEqual({
      kind: 'anonymous',
    });
    const authed = await GET(
      new Request('https://shop.example/api/v1/maybe', {
        headers: { authorization: 'Bearer user-token' },
      }),
    );
    expect(await body(authed)).toEqual({ kind: 'user' });
  });

  it('reads X-Client-Platform onto the context, ignoring junk', async () => {
    const seen: unknown[] = [];
    const GET = handle(
      okRoute,
      async (ctx) => {
        seen.push(ctx.platform);
        return { page: 1 };
      },
      { container: container() },
    );
    await GET(
      new Request('https://shop.example/api/v1/things', {
        headers: { 'x-client-platform': 'wechat-mini' },
      }),
    );
    await GET(
      new Request('https://shop.example/api/v1/things', {
        headers: { 'x-client-platform': 'nintendo' },
      }),
    );
    expect(seen).toEqual(['wechat-mini', null]);
  });

  it('reads a well-formed X-Client-Version onto the context and ignores junk', async () => {
    const seen: unknown[] = [];
    const GET = handle(
      okRoute,
      async (ctx) => {
        seen.push(ctx.clientVersion);
        return { page: 1 };
      },
      { container: container() },
    );
    for (const version of ['1.4.0', '2.0.0-beta.3', 'not a version', '9'.repeat(40), null]) {
      await GET(
        new Request('https://shop.example/api/v1/things', {
          headers: version === null ? {} : { 'x-client-version': version },
        }),
      );
    }
    expect(seen).toEqual(['1.4.0', '2.0.0-beta.3', undefined, undefined, undefined]);
  });
});

describe('authorisation', () => {
  it('403s when the admin lacks the route permission', async () => {
    const GET = handle(noContentRoute, async () => undefined, { container: container() });
    const response = await GET(
      new Request('https://shop.example/admin-api/things/1', {
        method: 'DELETE',
        headers: { cookie: `${ADMIN_COOKIE}=good-limited`, origin: 'https://shop.example' },
      }),
      { params: Promise.resolve({ id: '1' }) },
    );
    expect(response.status).toBe(403);
    const payload = await body(response);
    expect(payload.code).toBe('FORBIDDEN');
    expect(payload.details).toEqual({ permission: 'catalog:product:delete' });
  });

  it('lets a granted permission through', async () => {
    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });
    const response = await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=good-limited` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('lets a super admin through everything', async () => {
    const DELETE = handle(noContentRoute, async () => undefined, { container: container() });
    const response = await DELETE(
      new Request('https://shop.example/admin-api/things/1', {
        method: 'DELETE',
        headers: { cookie: `${ADMIN_COOKIE}=good-super`, origin: 'https://shop.example' },
      }),
      { params: Promise.resolve({ id: '1' }) },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('content-type')).toBeNull();
  });
});

describe('CSRF', () => {
  const post = (headers: Record<string, string>) =>
    new Request('https://shop.example/admin-api/things', {
      method: 'POST',
      body: JSON.stringify({ name: 'a' }),
      headers: { cookie: `${ADMIN_COOKIE}=good-super`, ...headers },
    });

  const POST = () => handle(adminMutation, async () => ({ ok: true }), { container: container() });

  it('accepts a same-origin fetch', async () => {
    expect((await POST()(post({ 'sec-fetch-site': 'same-origin' }))).status).toBe(200);
    expect((await POST()(post({ origin: 'https://shop.example' }))).status).toBe(200);
  });

  it('rejects a cross-site post that carries the cookie', async () => {
    const response = await POST()(post({ 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(403);
    expect((await body(response)).code).toBe('AUTH_CROSS_SITE_BLOCKED');
  });

  it('rejects an unknown Origin', async () => {
    const response = await POST()(post({ origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
  });

  it('rejects a post with neither header', async () => {
    expect((await POST()(post({}))).status).toBe(403);
  });

  it('does not apply to a GET, nor to a bearer-authenticated mutation', async () => {
    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });
    expect(
      (
        await GET(
          new Request('https://shop.example/admin-api/things', {
            headers: { cookie: `${ADMIN_COOKIE}=good-super` },
          }),
        )
      ).status,
    ).toBe(200);

    const storefrontPost = handle(bodyRoute, async () => ({ ok: true }), {
      container: container(),
    });
    const response = await storefrontPost(
      new Request('https://shop.example/api/v1/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'ab', count: 1 }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it('checkCsrf is a pure function of the two headers', () => {
    const allowed = ['https://shop.example'];
    const req = (headers: Record<string, string>) =>
      new Request('https://shop.example/x', { method: 'POST', headers });
    expect(checkCsrf(req({ 'sec-fetch-site': 'same-origin' }), allowed).ok).toBe(true);
    expect(checkCsrf(req({ 'sec-fetch-site': 'none' }), allowed).ok).toBe(true);
    expect(checkCsrf(req({ 'sec-fetch-site': 'cross-site' }), allowed).ok).toBe(false);
    // Sec-Fetch-Site wins over a spoofable Origin.
    expect(
      checkCsrf(req({ 'sec-fetch-site': 'cross-site', origin: 'https://shop.example' }), allowed)
        .ok,
    ).toBe(false);
  });

  it('AUTH-015 — a sibling subdomain is not the admin: same-site needs an allowed Origin', () => {
    const allowed = ['https://shop.example'];
    const req = (headers: Record<string, string>) =>
      new Request('https://shop.example/x', { method: 'POST', headers });
    expect(checkCsrf(req({ 'sec-fetch-site': 'same-site' }), allowed).ok).toBe(false);
    expect(
      checkCsrf(
        req({ 'sec-fetch-site': 'same-site', origin: 'https://blog.shop.example' }),
        allowed,
      ).ok,
    ).toBe(false);
    // A sibling the operator listed in EXTRA_ALLOWED_ORIGINS still works.
    expect(
      checkCsrf(req({ 'sec-fetch-site': 'same-site', origin: 'https://shop.example' }), allowed).ok,
    ).toBe(true);
  });
});

describe('cookies', () => {
  it('sets an httpOnly, SameSite=Lax cookie, not Secure outside production', async () => {
    const POST = handle(
      bodyRoute,
      async (ctx) => {
        ctx.setCookie(ADMIN_COOKIE, 'the-token', { maxAge: 3600 });
        return { ok: true };
      },
      { container: container() },
    );
    const response = await POST(
      new Request('https://shop.example/api/v1/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'ab', count: 1 }),
      }),
    );
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${ADMIN_COOKIE}=the-token`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure in production', async () => {
    const POST = handle(
      bodyRoute,
      async (ctx) => {
        ctx.setCookie(ADMIN_COOKIE, 't');
        return { ok: true };
      },
      { container: fakeContainer({ env: { ...env, NODE_ENV: 'production' } }) },
    );
    const response = await POST(
      new Request('https://shop.example/api/v1/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'ab', count: 1 }),
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('clearCookie expires it immediately', async () => {
    const POST = handle(
      bodyRoute,
      async (ctx) => {
        ctx.clearCookie(ADMIN_COOKIE);
        return { ok: true };
      },
      { container: container() },
    );
    const response = await POST(
      new Request('https://shop.example/api/v1/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'ab', count: 1 }),
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('readCookie finds one cookie among several', () => {
    const request = new Request('https://x/y', {
      headers: { cookie: `other=1; ${ADMIN_COOKIE}=abc%20def; third=3` },
    });
    expect(readCookie(request, ADMIN_COOKIE)).toBe('abc def');
    expect(readCookie(request, 'missing')).toBeNull();
    expect(readCookie(new Request('https://x/y'), ADMIN_COOKIE)).toBeNull();
  });
});

describe('error mapping', () => {
  it('maps a DomainError to its registered status and message', async () => {
    const GET = handle(
      okRoute,
      async () => {
        throw new DomainError('AUTH_INVALID_CREDENTIALS', { details: { hint: 'x' } });
      },
      { container: container() },
    );
    const response = await GET(new Request('https://shop.example/api/v1/things'));
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '账号或密码不正确',
      details: { hint: 'x' },
    });
  });

  it('turns anything else into a 500 INTERNAL that leaks nothing', async () => {
    const GET = handle(
      okRoute,
      async () => {
        throw new Error('connection to 10.0.0.5 refused: password=hunter2');
      },
      { container: container() },
    );
    const response = await GET(new Request('https://shop.example/api/v1/things'));
    expect(response.status).toBe(500);
    const payload = await body(response);
    expect(payload).toEqual({ code: 'INTERNAL', message: '服务器开小差了，请稍后再试' });
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });

  // What drizzle throws: its own error, with node-postgres' DatabaseError as the cause.
  const drizzleError = (pg: Record<string, string>) =>
    Object.assign(new Error('Failed query: delete from "shipping_templates" where "id" = $1'), {
      cause: Object.assign(new Error(pg.message), pg),
    });

  it('ROUTE-002 — a foreign-key violation on delete is a 409 REFERENCE_IN_USE that names no constraint', async () => {
    const DELETE = handle(
      okRoute,
      async () => {
        throw drizzleError({
          code: '23503',
          message:
            'update or delete on table "shipping_templates" violates foreign key constraint "products_shipping_template_id_fk" on table "products"',
          detail: 'Key (id)=(3) is still referenced from table "products".',
          constraint: 'products_shipping_template_id_fk',
          table: 'products',
        });
      },
      { container: container() },
    );
    const response = await DELETE(new Request('https://shop.example/api/v1/things'));
    expect(response.status).toBe(409);
    const payload = await body(response);
    expect(payload).toEqual({
      code: 'REFERENCE_IN_USE',
      message: '该数据仍被其他记录使用，无法删除',
    });
    expect(JSON.stringify(payload)).not.toMatch(/products|shipping|_fk/);
  });

  it('ROUTE-002 — a write pointing at a row that is gone is a 409 REFERENCE_MISSING', async () => {
    const POST = handle(
      okRoute,
      async () => {
        throw drizzleError({
          code: '23503',
          message:
            'insert or update on table "products" violates foreign key constraint "products_category_id_fk"',
          detail: 'Key (category_id)=(9) is not present in table "categories".',
          constraint: 'products_category_id_fk',
          table: 'products',
        });
      },
      { container: container() },
    );
    const response = await POST(new Request('https://shop.example/api/v1/things'));
    expect(response.status).toBe(409);
    const payload = await body(response);
    expect(payload.code).toBe('REFERENCE_MISSING');
    expect(JSON.stringify(payload)).not.toMatch(/products|categor|_fk/);
  });

  it('leaves other database errors a 500 INTERNAL', async () => {
    const GET = handle(
      okRoute,
      async () => {
        throw drizzleError({ code: '40P01', message: 'deadlock detected' });
      },
      { container: container() },
    );
    expect((await GET(new Request('https://shop.example/api/v1/things'))).status).toBe(500);
  });

  it('catches a rejected non-Error too', async () => {
    const GET = handle(okRoute, async () => Promise.reject('nope'), { container: container() });
    expect((await GET(new Request('https://shop.example/api/v1/things'))).status).toBe(500);
  });
});

describe('response validation', () => {
  it('refuses to send a response that does not match the contract', async () => {
    const GET = handle(okRoute, async () => ({ page: 'one' }) as never, {
      container: container(),
    });
    const response = await GET(new Request('https://shop.example/api/v1/things'));
    expect(response.status).toBe(500);
    const payload = await body(response);
    expect(payload.code).toBe('INTERNAL');
    // Outside production the mismatch is reported, so a stream sees its own bug.
    expect(payload.details[0].field).toBe('response.page');
  });

  it('hides the mismatch details in production', async () => {
    const GET = handle(okRoute, async () => ({ page: 'one' }) as never, {
      container: fakeContainer({ env: { ...env, NODE_ENV: 'production' } }),
    });
    expect(
      (await body(await GET(new Request('https://shop.example/api/v1/things')))).details,
    ).toBeUndefined();
  });

  it('skips the check when VALIDATE_RESPONSES is off', async () => {
    const GET = handle(okRoute, async () => ({ page: 'one' }) as never, {
      container: fakeContainer({ env: { ...env, VALIDATE_RESPONSES: false } }),
    });
    expect((await GET(new Request('https://shop.example/api/v1/things'))).status).toBe(200);
  });
});

describe('request id and logging', () => {
  it('echoes an incoming x-request-id and invents one otherwise', async () => {
    const GET = handle(okRoute, async () => ({ page: 1 }), { container: container() });
    const echoed = await GET(
      new Request('https://shop.example/api/v1/things', {
        headers: { 'x-request-id': 'abc-123' },
      }),
    );
    expect(echoed.headers.get('x-request-id')).toBe('abc-123');

    const invented = await GET(new Request('https://shop.example/api/v1/things'));
    expect(invented.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs one structured line per request', async () => {
    const logger = silentLogger();
    const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.spyOn(logger, 'child').mockReturnValue(child as never);
    const GET = handle(okRoute, async () => ({ page: 1 }), {
      container: fakeContainer({ logger }),
    });
    await GET(new Request('https://shop.example/api/v1/things'));
    expect(child.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/api/v1/things', status: 200 }),
      'request',
    );
  });

  // A readiness probe's 503 is "not yet", polled on every deploy;
  // logged at `error` it buries the one line that is. The route declares the
  // status; nothing is inferred, and a route that says nothing logs as before.
  it('logs a status the route declares as expected at info, and the same status elsewhere as before', async () => {
    const spyLogger = () => {
      const logger = silentLogger();
      const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      vi.spyOn(logger, 'child').mockReturnValue(child as never);
      return { logger, child };
    };
    const notFound = async () => {
      throw new DomainError('NOT_FOUND');
    };

    const declared = spyLogger();
    const probe = defineRoute({ ...okRoute, id: 'test.probe', expectedStatuses: [404] });
    const probed = await handle(probe, notFound, { container: fakeContainer(declared) })(
      new Request('https://shop.example/api/v1/things'),
    );
    expect(probed.status).toBe(404);
    expect(declared.child.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      'request',
    );
    expect(declared.child.warn).not.toHaveBeenCalled();

    const silent = spyLogger();
    const plain = await handle(okRoute, notFound, { container: fakeContainer(silent) })(
      new Request('https://shop.example/api/v1/things'),
    );
    expect(plain.status).toBe(404);
    expect(silent.child.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      'request',
    );
    expect(silent.child.info).not.toHaveBeenCalled();
  });
});

describe('audit log', () => {
  it('records a successful admin mutation', async () => {
    const POST = handle(
      adminMutation,
      async (ctx) => {
        ctx.audit('thing:1');
        return { ok: true };
      },
      { container: container() },
    );
    const response = await POST(
      new Request('https://shop.example/admin-api/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'a' }),
        headers: { cookie: `${ADMIN_COOKIE}=good-super`, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(response.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      adminId: 1,
      adminAccount: 'admin',
      routeId: 'test.adminWrite',
      method: 'POST',
      target: 'thing:1',
      status: 200,
    });
  });

  it('does not record a GET, and does not record a failure', async () => {
    const GET = handle(adminRoute, async () => ({ ok: true }), { container: container() });
    await GET(
      new Request('https://shop.example/admin-api/things', {
        headers: { cookie: `${ADMIN_COOKIE}=good-super` },
      }),
    );
    expect(audits).toHaveLength(0);

    const POST = handle(
      adminMutation,
      async () => {
        throw new DomainError('NOT_FOUND');
      },
      { container: container() },
    );
    await POST(
      new Request('https://shop.example/admin-api/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'a' }),
        headers: { cookie: `${ADMIN_COOKIE}=good-super`, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(audits).toHaveLength(0);
  });

  it('AUTH-013: records a GET the handler named with ctx.audit (an export), with its filters', async () => {
    const exportRoute = defineRoute({
      id: 'test.adminExport',
      method: 'GET',
      path: '/admin-api/things/exports',
      auth: 'admin',
      permission: 'catalog:product:read',
      summary: 'admin export',
      tags: ['test'],
      query: z.object({ status: z.string().optional() }),
      response: z.object({ ok: z.boolean() }),
      examples: [{ name: 'ok', query: {}, response: { ok: true } }],
    });
    const GET = handle(
      exportRoute,
      async (ctx) => {
        ctx.audit('thing-export:3');
        return { ok: true };
      },
      { container: container() },
    );
    const response = await GET(
      new Request('https://shop.example/admin-api/things/exports?status=paid', {
        headers: { cookie: `${ADMIN_COOKIE}=good-super` },
      }),
    );
    expect(response.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      routeId: 'test.adminExport',
      method: 'GET',
      target: 'thing-export:3',
    });
    expect(JSON.parse(String((audits[0] as { payload: unknown }).payload))).toEqual({
      status: 'paid',
    });
  });

  it('never fails the request when the audit write fails', async () => {
    const broken = fakeContainer({
      db: {
        insert: () => ({
          values: async () => {
            throw new Error('audit table is on fire');
          },
        }),
      } as never,
    });
    const POST = handle(adminMutation, async () => ({ ok: true }), { container: broken });
    const response = await POST(
      new Request('https://shop.example/admin-api/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'a' }),
        headers: { cookie: `${ADMIN_COOKIE}=good-super`, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('conditional GET — ctx.etag / ctx.notModified', () => {
  const versioned = (version: string) =>
    handle(
      okRoute,
      async (ctx, { query }) => {
        ctx.setHeader('cache-control', 'no-cache');
        if (ctx.etag(version)) ctx.notModified();
        return { page: query.page };
      },
      { container: container() },
    );
  const get = (headers: Record<string, string> = {}) =>
    new Request('https://shop.example/api/v1/things', { headers });

  it('sends the tag with the body when the caller offers none', async () => {
    const response = await versioned('v1')(get());
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(await body(response)).toEqual({ page: 1 });
  });

  it('answers 304 with no body, keeping the tag and the headers already set', async () => {
    const response = await versioned('v1')(get({ 'if-none-match': '"v1"' }));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('content-type')).toBeNull();
  });

  it('compares weakly, reads a list, and treats * as a match', async () => {
    for (const offered of ['W/"v1"', '"v0", "v1"', ' "v0" ,W/"v1" ', '*']) {
      expect((await versioned('v1')(get({ 'if-none-match': offered }))).status, offered).toBe(304);
    }
  });

  it('sends the new version when the caller holds an old one', async () => {
    for (const offered of ['"v0"', 'v1', '"v1-old"', '']) {
      const response = await versioned('v1')(get({ 'if-none-match': offered }));
      expect(response.status, offered).toBe(200);
      expect(await body(response)).toEqual({ page: 1 });
    }
  });

  it('sends a weak tag when asked, and still matches either form of it', async () => {
    const GET = handle(
      okRoute,
      async (ctx) => {
        if (ctx.etag('v1', { weak: true })) ctx.notModified();
        return { page: 1 };
      },
      { container: container() },
    );
    const fresh = await GET(get());
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).toBe('W/"v1"');
    for (const offered of ['W/"v1"', '"v1"']) {
      const response = await GET(get({ 'if-none-match': offered }));
      expect(response.status, offered).toBe(304);
      expect(response.headers.get('etag')).toBe('W/"v1"');
    }
  });

  it('does not validate a 304 against the response contract', async () => {
    // The handler never produces a value, so there is nothing to validate;
    // validation would otherwise turn `undefined` into a 500.
    const GET = handle(
      okRoute,
      async (ctx) => {
        ctx.etag('v1');
        return ctx.notModified();
      },
      { container: container() },
    );
    expect((await GET(get({ 'if-none-match': '"v1"' }))).status).toBe(304);
  });

  it('writes no audit row', async () => {
    const POST = handle(
      adminMutation,
      async (ctx) => {
        ctx.audit('thing:1');
        return ctx.notModified();
      },
      { container: container() },
    );
    const response = await POST(
      new Request('https://shop.example/admin-api/things', {
        method: 'POST',
        body: JSON.stringify({ name: 'a' }),
        headers: { cookie: `${ADMIN_COOKIE}=good-super`, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(response.status).toBe(304);
    expect(audits).toHaveLength(0);
  });
});

describe('searchParamsToObject', () => {
  it('keeps a single value scalar and a repeated key an array', () => {
    expect(searchParamsToObject(new URLSearchParams('a=1&b=2&b=3'))).toEqual({
      a: '1',
      b: ['2', '3'],
    });
    expect(searchParamsToObject(new URLSearchParams(''))).toEqual({});
  });
});
