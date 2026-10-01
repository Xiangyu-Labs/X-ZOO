import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { articles } from '@shop/db/schema/cms';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The CMS routes as HTTP, against a real database.
 *
 * The domain behaviour is pinned down in `packages/core/src/cms/cms.int.test.ts`.
 * What is proved here is only what a route file can get wrong: the contract is
 * bound to the right method and path, `auth` and `permission` run before the
 * service, a body is refused before anything is written, a domain refusal
 * arrives as its declared status and Chinese message, a write lands in
 * `audit_logs`, and the storefront read is public — which is the whole point of
 * an article.
 */

let harness: TestCtx;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;
const ORIGIN = 'https://shop.example';

const env: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'unused',
  REDIS_URL: 'unused',
  UPLOADS_DIR: '/tmp/uploads',
  UPLOADS_PUBLIC_PREFIX: '/uploads',
  APP_ORIGIN: ORIGIN,
  EXTRA_ALLOWED_ORIGINS: [],
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  VALIDATE_RESPONSES: true,
  DB_POOL_MAX: 5,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z' });
  const container: Container = {
    env,
    dbHandle: harness.db.handle,
    db: harness.ctx.db,
    redis: harness.redis,
    clock: harness.clock,
    logger: harness.ctx.logger,
    queue: harness.ctx.queue,
    storage: harness.ctx.storage,
    config: harness.ctx.config,
    adminAuth: new AdminAuthService(harness.ctx, { bcryptCost: BCRYPT_COST }),
    userSessions: new UserSessionService(),
    close: async () => {},
  };
  setContainer(container);
}, 180_000);

afterAll(async () => {
  setContainer(undefined);
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

let roleSeq = 0;

async function adminCookie(permissions?: string[]): Promise<Record<string, string>> {
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account: 'operator',
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: '运营',
      isSuper: permissions === undefined,
    })
    .returning({ id: admins.id });

  if (permissions?.length) {
    const [role] = await harness.ctx.db
      .insert(roles)
      .values({ name: `cms-operator-${(roleSeq += 1)}` })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../auth/login/route');
  const response = await login(
    json('POST', '/admin-api/auth/login', { account: 'operator', password: PASSWORD }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

async function createArticle(
  headers: Record<string, string>,
  body: Record<string, unknown> = { title: '双十一活动说明', status: 'published' },
): Promise<{ id: string }> {
  const { POST } = await import('./articles/route');
  const response = await POST(json('POST', '/admin-api/cms/articles', body, headers));
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// the admin surface
// ---------------------------------------------------------------------------

describe('/admin-api/cms/articles', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('./articles/route');

    expect((await GET(get('/admin-api/cms/articles?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/cms/articles?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('lists for an admin holding cms:article:read', async () => {
    const headers = await adminCookie(['cms:article:read']);
    const { GET } = await import('./articles/route');

    const response = await GET(get('/admin-api/cms/articles?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('creates with 201 and writes an audit row', async () => {
    const headers = await adminCookie(['cms:article:write', 'cms:article:read']);
    const created = await createArticle(headers);

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      routeId: 'cms.adminArticleCreate',
      target: `cms:article:${created.id}`,
    });
  });

  it('422s a form the schema refuses, before writing anything', async () => {
    const headers = await adminCookie(['cms:article:write']);
    const { POST } = await import('./articles/route');

    const response = await POST(
      json('POST', '/admin-api/cms/articles', { title: '', slug: 'Not A Slug' }, headers),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(articles)).toHaveLength(0);
  });

  it('reports a missing article as the contract declares, in Chinese', async () => {
    const headers = await adminCookie();
    const { GET } = await import('./articles/[id]/route');

    const response = await GET(get('/admin-api/cms/articles/999', headers), {
      params: Promise.resolve({ id: '999' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'CMS_ARTICLE_NOT_FOUND',
      message: '文章不存在',
    });
  });

  it('keeps delete on its own permission', async () => {
    const headers = await adminCookie(['cms:article:write', 'cms:article:read']);
    const created = await createArticle(headers);
    const { DELETE } = await import('./articles/[id]/route');

    const forbidden = await DELETE(
      json('DELETE', `/admin-api/cms/articles/${created.id}`, undefined, headers),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(forbidden.status).toBe(403);
  });
});

describe('/admin-api/cms/article-categories', () => {
  it('refuses to delete a category that still holds an article, with its counts', async () => {
    const headers = await adminCookie();
    const { POST: createCategory } = await import('./article-categories/route');
    const category = (await (
      await createCategory(
        json('POST', '/admin-api/cms/article-categories', { title: '新闻资讯' }, headers),
      )
    ).json()) as { id: string };
    await createArticle(headers, { title: '公告', categoryId: category.id });

    const { DELETE } = await import('./article-categories/[id]/route');
    const response = await DELETE(
      json('DELETE', `/admin-api/cms/article-categories/${category.id}`, undefined, headers),
      { params: Promise.resolve({ id: category.id }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'CMS_CATEGORY_NOT_EMPTY',
      details: { children: 0, articles: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// the storefront surface
// ---------------------------------------------------------------------------

describe('/api/v1/articles', () => {
  it('reads without a session, and never serves a draft', async () => {
    const headers = await adminCookie();
    const published = await createArticle(headers);
    const draft = await createArticle(headers, { title: '草稿', status: 'draft' });

    const { GET: list } = await import('../../api/v1/articles/route');
    const listed = await list(get('/api/v1/articles?page=1&pageSize=20'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 1 });

    const { GET: detail } = await import('../../api/v1/articles/[id]/route');
    const open = await detail(get(`/api/v1/articles/${published.id}`), {
      params: Promise.resolve({ id: published.id }),
    });
    expect(open.status).toBe(200);
    // The read counted, and the response carries the number it produced.
    expect(await open.json()).toMatchObject({ views: 1 });

    const hidden = await detail(get(`/api/v1/articles/${draft.id}`), {
      params: Promise.resolve({ id: draft.id }),
    });
    expect(hidden.status).toBe(404);
  });
});
