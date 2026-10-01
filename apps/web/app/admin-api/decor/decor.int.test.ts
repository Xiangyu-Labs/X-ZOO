import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { decorDocuments } from '@shop/db/schema/decor';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The 页面装修 v2 admin routes as HTTP, against a real database.
 *
 * The domain rules are proved in `packages/core/src/decor/*.int.test.ts`. What
 * is proved here is what a route file can get wrong: the contract bound to the
 * right method and path, `auth` and `permission` before the service (and the
 * three atoms split read / write / publish), the body validated before
 * anything is written, a refusal arriving with its declared status and
 * Chinese message, and every write in `audit_logs` with its target. The
 * container validates responses, so every answer also matches its contract.
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

type Headers = Record<string, string>;

const json = (method: string, path: string, body?: unknown, headers: Headers = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  });

const get = (path: string, headers: Headers = {}) => new Request(`${ORIGIN}${path}`, { headers });

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let adminSeq = 0;

/** A signed-in admin: super without `permissions`, else holding exactly those atoms. */
async function adminCookie(permissions?: string[]): Promise<Headers> {
  adminSeq += 1;
  const account = `operator${adminSeq}`;
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account,
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: '运营',
      isSuper: permissions === undefined,
    })
    .returning({ id: admins.id });

  if (permissions?.length) {
    const [role] = await harness.ctx.db
      .insert(roles)
      .values({ name: `decor-operator-${adminSeq}` })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../auth/login/route');
  const response = await login(
    json('POST', '/admin-api/auth/login', { account, password: PASSWORD }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

const ALL = ['decor:page:read', 'decor:page:write', 'decor:page:publish'];

async function audits(): Promise<{ routeId: string; target: string | null }[]> {
  const rows = await harness.ctx.db.select().from(auditLogs).orderBy(auditLogs.id);
  return rows
    .filter((row) => row.routeId !== 'auth.adminLogin')
    .map((row) => ({ routeId: row.routeId, target: row.target }));
}

const slide = { image: 'https://cdn.example.com/banner.jpg' };

function doc(blocks: unknown[]) {
  return {
    schemaVersion: 2,
    root: { props: { title: '首页', background: '#f5f5f5', shareEnabled: true, shareTitle: '' } },
    blocks,
  };
}

async function create(headers: Headers, body: unknown = { kind: 'home', name: '新首页' }) {
  const { POST } = await import('./documents/route');
  const response = await POST(json('POST', '/admin-api/decor/documents', body, headers));
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; draftVersion: string };
}

async function saveDraft(headers: Headers, id: string, document: unknown, version: string) {
  const { PUT } = await import('./documents/[id]/draft/route');
  return PUT(
    json('PUT', `/admin-api/decor/documents/${id}/draft`, { document, version }, headers),
    params({ id }),
  );
}

async function publish(headers: Headers, id: string, body: unknown = { note: '上线' }) {
  const { POST } = await import('./documents/[id]/publish/route');
  return POST(
    json('POST', `/admin-api/decor/documents/${id}/publish`, body, headers),
    params({ id }),
  );
}

async function designate(headers: Headers, designation: string, documentId: string | null) {
  const { PUT } = await import('./designations/[designation]/route');
  return PUT(
    json('PUT', `/admin-api/decor/designations/${designation}`, { documentId }, headers),
    params({ designation }),
  );
}

// ---------------------------------------------------------------------------
// the admin surface
// ---------------------------------------------------------------------------

describe('/admin-api/decor — permissions', () => {
  it('401s without a session and 403s without the atom', async () => {
    const { GET } = await import('./documents/route');
    expect((await GET(get('/admin-api/decor/documents?page=1&pageSize=20'))).status).toBe(401);

    const unrelated = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/decor/documents?page=1&pageSize=20', unrelated));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('keeps publishing apart from editing: a writer may save but not publish or designate', async () => {
    const writer = await adminCookie(['decor:page:read', 'decor:page:write']);
    const created = await create(writer);
    const saved = await saveDraft(writer, created.id, doc([]), created.draftVersion);
    expect(saved.status).toBe(200);

    expect((await publish(writer, created.id)).status).toBe(403);
    expect((await designate(writer, 'home', created.id)).status).toBe(403);

    const { POST: rollback } = await import('./documents/[id]/revisions/[number]/rollback/route');
    const refused = await rollback(
      json(
        'POST',
        `/admin-api/decor/documents/${created.id}/revisions/1/rollback`,
        { note: '' },
        writer,
      ),
      params({ id: created.id, number: '1' }),
    );
    expect(refused.status).toBe(403);
  });

  it('a reader may list, read and preview, but not write', async () => {
    const reader = await adminCookie(['decor:page:read']);
    const { POST } = await import('./documents/route');
    const refused = await POST(
      json('POST', '/admin-api/decor/documents', { kind: 'home', name: '页' }, reader),
    );
    expect(refused.status).toBe(403);

    const created = await create(await adminCookie());
    const { POST: previewToken } = await import('./documents/[id]/preview-token/route');
    const issued = await previewToken(
      json('POST', `/admin-api/decor/documents/${created.id}/preview-token`, {}, reader),
      params({ id: created.id }),
    );
    expect(issued.status).toBe(201);
    expect(await issued.json()).toMatchObject({ previewToken: expect.any(String) });
  });
});

describe('/admin-api/decor — the document lifecycle', () => {
  it('create → save → publish → revisions → rollback → designate → delete, each audited', async () => {
    const headers = await adminCookie(ALL);
    const created = await create(headers);

    const { GET: read } = await import('./documents/[id]/route');
    const detail = await read(
      get(`/admin-api/decor/documents/${created.id}`, headers),
      params({ id: created.id }),
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ kind: 'home', name: '新首页', published: null });

    const first = await saveDraft(
      headers,
      created.id,
      doc([{ id: 'b', type: 'carousel', v: 1, props: { slides: [slide] } }]),
      created.draftVersion,
    );
    const firstBody = (await first.json()) as { version: string; issues: unknown[] };
    expect(firstBody.issues).toEqual([]);

    const stale = await saveDraft(headers, created.id, doc([]), created.draftVersion);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'DECOR_VERSION_CONFLICT',
      message: '页面已被其他人修改，请刷新后重新保存',
      details: { version: firstBody.version },
    });

    const published = await publish(headers, created.id, {
      version: firstBody.version,
      note: '首发',
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ revision: { number: 1, note: '首发' } });

    const again = await publish(headers, created.id);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('DECOR_NOTHING_TO_PUBLISH');

    await saveDraft(headers, created.id, doc([]), firstBody.version);
    expect((await publish(headers, created.id)).status).toBe(200);

    const { GET: revisions } = await import('./documents/[id]/revisions/route');
    const list = await revisions(
      get(`/admin-api/decor/documents/${created.id}/revisions`, headers),
      params({ id: created.id }),
    );
    expect(
      ((await list.json()) as { items: { number: number }[] }).items.map((item) => item.number),
    ).toEqual([2, 1]);

    const { GET: revision } = await import('./documents/[id]/revisions/[number]/route');
    const one = await revision(
      get(`/admin-api/decor/documents/${created.id}/revisions/1`, headers),
      params({ id: created.id, number: '1' }),
    );
    expect(one.status).toBe(200);
    expect(((await one.json()) as { content: { blocks: unknown[] } }).content.blocks).toHaveLength(
      1,
    );

    const { POST: rollback } = await import('./documents/[id]/revisions/[number]/rollback/route');
    const rolled = await rollback(
      json(
        'POST',
        `/admin-api/decor/documents/${created.id}/revisions/1/rollback`,
        { note: '回滚' },
        headers,
      ),
      params({ id: created.id, number: '1' }),
    );
    expect(rolled.status).toBe(200);
    expect(await rolled.json()).toMatchObject({ revision: { number: 3, restoredFrom: 1 } });

    expect((await designate(headers, 'home', created.id)).status).toBe(200);
    const { GET: designations } = await import('./designations/route');
    const current = await designations(get('/admin-api/decor/designations', headers));
    expect(await current.json()).toMatchObject({ home: { id: created.id }, user_center: null });

    const { DELETE } = await import('./documents/[id]/route');
    const inUse = await DELETE(
      json('DELETE', `/admin-api/decor/documents/${created.id}`, undefined, headers),
      params({ id: created.id }),
    );
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({
      code: 'DECOR_DOCUMENT_IN_USE',
      message: '页面正在使用中，请先更换后再删除',
    });

    expect((await designate(headers, 'home', null)).status).toBe(200);
    const deleted = await DELETE(
      json('DELETE', `/admin-api/decor/documents/${created.id}`, undefined, headers),
      params({ id: created.id }),
    );
    expect(deleted.status).toBe(204);

    const id = created.id;
    expect(await audits()).toEqual([
      { routeId: 'decor.adminDocumentCreate', target: `decor:document:${id}` },
      { routeId: 'decor.adminDraftSave', target: `decor:document:${id}` },
      { routeId: 'decor.adminPublish', target: `decor:document:${id}:revision:1` },
      { routeId: 'decor.adminDraftSave', target: `decor:document:${id}` },
      { routeId: 'decor.adminPublish', target: `decor:document:${id}:revision:2` },
      { routeId: 'decor.adminRollback', target: `decor:document:${id}:revision:3` },
      { routeId: 'decor.adminDesignate', target: 'decor:designation:home' },
      { routeId: 'decor.adminDesignate', target: 'decor:designation:home' },
      { routeId: 'decor.adminDocumentDelete', target: `decor:document:${id}` },
    ]);
  });

  it('rename and duplicate are audited; the copy is unpublished', async () => {
    const headers = await adminCookie(ALL);
    const created = await create(headers, { kind: 'custom', name: '活动页' });

    const { PATCH } = await import('./documents/[id]/route');
    const renamed = await PATCH(
      json('PATCH', `/admin-api/decor/documents/${created.id}`, { name: '双十一' }, headers),
      params({ id: created.id }),
    );
    expect(await renamed.json()).toMatchObject({ name: '双十一' });

    const { POST: duplicate } = await import('./documents/[id]/duplicate/route');
    const copied = await duplicate(
      json('POST', `/admin-api/decor/documents/${created.id}/duplicate`, {}, headers),
      params({ id: created.id }),
    );
    expect(copied.status).toBe(201);
    const copy = (await copied.json()) as { id: string; name: string; published: unknown };
    expect(copy).toMatchObject({ name: '双十一 副本', published: null });

    const { GET } = await import('./documents/route');
    const list = await GET(
      get('/admin-api/decor/documents?page=1&pageSize=20&kind=custom', headers),
    );
    expect(((await list.json()) as { total: number }).total).toBe(2);

    expect(await audits()).toEqual([
      { routeId: 'decor.adminDocumentCreate', target: `decor:document:${created.id}` },
      { routeId: 'decor.adminDocumentRename', target: `decor:document:${created.id}` },
      { routeId: 'decor.adminDocumentDuplicate', target: `decor:document:${copy.id}` },
    ]);
  });
});

describe('/admin-api/decor — validation', () => {
  it('422s a body the contract refuses, before writing anything', async () => {
    const headers = await adminCookie(ALL);
    const { POST } = await import('./documents/route');
    const response = await POST(
      json('POST', '/admin-api/decor/documents', { kind: 'home', name: '' }, headers),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(decorDocuments)).toHaveLength(0);
  });

  it('refuses to publish a draft with issues, listing them', async () => {
    const headers = await adminCookie(ALL);
    const created = await create(headers);
    await saveDraft(
      headers,
      created.id,
      doc([{ id: 'b', type: 'carousel', v: 1, props: { slides: [] } }]),
      created.draftVersion,
    );
    const response = await publish(headers, created.id);
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      code: string;
      details: { issues: { path: string }[] };
    };
    expect(body.code).toBe('DECOR_DOCUMENT_INVALID');
    expect(body.details.issues.map((issue) => issue.path)).toContain('blocks.0.props.slides');
  });

  it('reports a missing document in Chinese, and a kind mismatch on designate', async () => {
    const headers = await adminCookie();
    const { GET } = await import('./documents/[id]/route');
    const missing = await GET(
      get('/admin-api/decor/documents/999', headers),
      params({ id: '999' }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: 'DECOR_DOCUMENT_NOT_FOUND',
      message: '页面不存在',
    });

    const created = await create(headers, { kind: 'custom', name: '页' });
    const mismatch = await designate(headers, 'user_center', created.id);
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { code: string }).code).toBe('DECOR_KIND_MISMATCH');
  });
});
