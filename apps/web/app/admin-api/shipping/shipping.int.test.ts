import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { cities, expressCompanies as expressCompanyTable } from '@shop/db/schema/reference';
import { shippingTemplates } from '@shop/db/schema/shipping';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { resetCityTreeCache } from '@shop/core/shipping';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The shipping routes as HTTP, against a real database.
 *
 * The freight arithmetic and the template rules are pinned down in
 * `packages/core/src/shipping/*.test.ts`. What is proved here is only what a
 * route file can get wrong: the contract is bound to the right method and path,
 * `auth` and `permission` run before the service, a body is refused before
 * anything is written, a domain refusal arrives as its declared status and
 * Chinese message, and a write lands in `audit_logs`.
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
  resetCityTreeCache();
  await harness.ctx.db.insert(cities).values([
    { id: 330000, parentId: null, level: 0, name: '浙江' },
    { id: 330100, parentId: 330000, level: 1, name: '杭州市' },
    { id: 330106, parentId: 330100, level: 2, name: '西湖区' },
  ]);
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
      account: 'shipper',
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: '仓管',
      isSuper: permissions === undefined,
    })
    .returning({ id: admins.id });

  if (permissions?.length) {
    const [role] = await harness.ctx.db
      .insert(roles)
      .values({ name: `shipping-operator-${(roleSeq += 1)}` })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../auth/login/route');
  const response = await login(
    json('POST', '/admin-api/auth/login', { account: 'shipper', password: PASSWORD }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

/** The smallest template the form accepts: one fallback rule, no free rules. */
function templateForm(overrides: Record<string, unknown> = {}) {
  return {
    name: '全国统一运费',
    chargeMode: 'quantity',
    hasFreeRules: false,
    hasNoDeliveryRules: false,
    sortOrder: 0,
    regions: [
      {
        isFallback: true,
        cityIds: [],
        firstUnit: 1,
        firstPrice: '10.00',
        additionalUnit: 1,
        additionalPrice: '5.00',
      },
    ],
    freeRules: [],
    noDeliveryCityIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

describe('/admin-api/shipping/templates', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('./templates/route');

    expect((await GET(get('/admin-api/shipping/templates?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/shipping/templates?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('creates with 201 and writes an audit row', async () => {
    const headers = await adminCookie(['shipping:template:write']);
    const { POST } = await import('./templates/route');

    const response = await POST(
      json('POST', '/admin-api/shipping/templates', templateForm(), headers),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      routeId: 'shipping.templateCreate',
      target: `shipping-template:${created.id}`,
    });
  });

  it('422s a form the schema refuses, before writing anything', async () => {
    const headers = await adminCookie(['shipping:template:write']);
    const { POST } = await import('./templates/route');

    const response = await POST(
      json(
        'POST',
        '/admin-api/shipping/templates',
        templateForm({ name: '', chargeMode: 'parsecs' }),
        headers,
      ),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(shippingTemplates)).toHaveLength(0);
  });

  it('reports an unknown city as the contract declares, in Chinese, and writes nothing', async () => {
    const headers = await adminCookie(['shipping:template:write']);
    const { POST } = await import('./templates/route');

    const response = await POST(
      json(
        'POST',
        '/admin-api/shipping/templates',
        templateForm({
          regions: [
            ...templateForm().regions,
            {
              isFallback: false,
              cityIds: ['999999'],
              firstUnit: 1,
              firstPrice: '20.00',
              additionalUnit: 1,
              additionalPrice: '10.00',
            },
          ],
        }),
        headers,
      ),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'SHIPPING_CITY_UNKNOWN',
      message: '所选地区不存在，请重新选择',
      details: { cityIds: ['999999'] },
    });
    expect(await harness.ctx.db.select().from(shippingTemplates)).toHaveLength(0);
  });

  it('reports a missing template as 404 with its Chinese message', async () => {
    const headers = await adminCookie();
    const { GET } = await import('./templates/[id]/route');

    const response = await GET(get('/admin-api/shipping/templates/999', headers), {
      params: Promise.resolve({ id: '999' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'SHIPPING_TEMPLATE_NOT_FOUND',
      message: '运费模板不存在',
    });
  });

  it('keeps delete on its own permission', async () => {
    const headers = await adminCookie(['shipping:template:write', 'shipping:template:read']);
    const { POST } = await import('./templates/route');
    const created = (await (
      await POST(json('POST', '/admin-api/shipping/templates', templateForm(), headers))
    ).json()) as { id: string };

    const { DELETE } = await import('./templates/[id]/route');
    const forbidden = await DELETE(
      json('DELETE', `/admin-api/shipping/templates/${created.id}`, undefined, headers),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(forbidden.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// express companies
// ---------------------------------------------------------------------------

describe('/admin-api/shipping/express-companies', () => {
  it('refuses a duplicate code as 409 with its Chinese message', async () => {
    const headers = await adminCookie(['shipping:express:write']);
    const { POST } = await import('./express-companies/route');
    const body = { code: 'SF', name: '顺丰速运', sortOrder: 100, isEnabled: true };

    expect(
      (await POST(json('POST', '/admin-api/shipping/express-companies', body, headers))).status,
    ).toBe(201);

    const duplicate = await POST(
      json('POST', '/admin-api/shipping/express-companies', { ...body, name: '顺丰' }, headers),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      code: 'SHIPPING_EXPRESS_COMPANY_CODE_TAKEN',
      message: '该快递公司编码已存在',
      details: { code: 'SF' },
    });
    expect(await harness.ctx.db.select().from(expressCompanyTable)).toHaveLength(1);
  });

  it('audits a status flip', async () => {
    const headers = await adminCookie(['shipping:express:write']);
    const { POST: create } = await import('./express-companies/route');
    const created = (await (
      await create(
        json(
          'POST',
          '/admin-api/shipping/express-companies',
          { code: 'YTO', name: '圆通速递' },
          headers,
        ),
      )
    ).json()) as { id: string };

    const { POST: setStatus } = await import('./express-companies/[id]/status/route');
    const response = await setStatus(
      json(
        'POST',
        `/admin-api/shipping/express-companies/${created.id}/status`,
        { isEnabled: false },
        headers,
      ),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isEnabled: false });

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit.map((row) => row.routeId)).toEqual([
      'shipping.expressCompanyCreate',
      'shipping.expressCompanySetStatus',
    ]);
  });

  it('opens the 发货 picker to anyone who may read orders', async () => {
    await harness.ctx.db
      .insert(expressCompanyTable)
      .values([{ code: 'SF', name: '顺丰速运', sortOrder: 100, isEnabled: true }]);
    const headers = await adminCookie(['order:order:read']);
    const { GET } = await import('../express-companies/route');

    const response = await GET(get('/admin-api/express-companies', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ code: 'SF', name: '顺丰速运' }] });
  });
});

// ---------------------------------------------------------------------------
// the city tree
// ---------------------------------------------------------------------------

describe('/admin-api/shipping/cities', () => {
  it('serves the same tree the storefront gets, to an admin who may read templates', async () => {
    const headers = await adminCookie(['shipping:template:read']);
    const { GET } = await import('./cities/route');

    const response = await GET(get('/admin-api/shipping/cities', headers));
    expect(response.status).toBe(200);
    const tree = (await response.json()) as { items: Record<string, unknown>[] };
    expect(tree.items).toHaveLength(1);
    expect(tree.items[0]).toMatchObject({ id: '330000', name: '浙江' });
  });
});
