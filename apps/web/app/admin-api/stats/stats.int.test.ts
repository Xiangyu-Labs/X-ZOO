import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { statsConfig } from '@shop/core/stats';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The ten statistics routes as HTTP, against a real database.
 *
 * Every figure is already proved against a hand-derived fixture in
 * `@shop/core/src/stats/stats.int.test.ts`; nothing here re-derives a number.
 * What is proved here is only what a route file can get wrong:
 *
 * - the contract is bound to the right method and path, and to the service the
 *   path names (a copy-paste between ten near-identical files is exactly the
 *   mistake that would otherwise ship);
 * - `auth` and `permission` run before the service, and the **eight** permission
 *   atoms are genuinely eight — a read atom does not open an export, and one
 *   page's atom does not open another page;
 * - a bad window is refused with 422 before any query runs;
 * - the export envelope comes back whole, and its refusal maps to 422;
 * - a statistics read writes **no** audit row. The domain is select-only, and
 *   an audit log that fills up with page views is one nobody reads.
 *
 * `VALIDATE_RESPONSES` is on, as in CI, so each 200 below is also an assertion
 * that the service's output satisfies the response schema.
 */

let harness: TestCtx;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;
const ORIGIN = 'https://shop.example';
const NOW = '2026-02-04T10:00:00+08:00';

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
  harness = await createTestCtx({ now: NOW });
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
  harness.clock.set(NOW);
  await harness.redis.flushdb();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

/** Logs an admin in and returns the cookie header a later request presents. */
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
      .values({ name: 'stats-operator' })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../auth/login/route');
  const response = await login(
    new Request(`${ORIGIN}/admin-api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ account: 'operator', password: PASSWORD }),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

/**
 * The ten routes, each with the atom it requires and a query that satisfies
 * its contract. The thunks are literal imports on purpose: a computed
 * specifier would not prove that the file at that path exists.
 */
const ROUTES = [
  {
    name: '用户统计',
    path: '/admin-api/stats/users',
    permission: 'stats:user:read',
    load: () => import('./users/route'),
  },
  {
    name: '用户地域分布',
    path: '/admin-api/stats/users/regions?sortBy=totalUsers&limit=10',
    permission: 'stats:user:read',
    load: () => import('./users/regions/route'),
  },
  {
    name: '商品统计',
    path: '/admin-api/stats/products',
    permission: 'stats:product:read',
    load: () => import('./products/route'),
  },
  {
    name: '商品排行',
    path: '/admin-api/stats/products/ranking?sortBy=paidAmount&limit=20',
    permission: 'stats:product:read',
    load: () => import('./products/ranking/route'),
  },
  {
    name: '导出商品统计',
    path: '/admin-api/stats/products/exports?sortBy=paidAmount&limit=20',
    permission: 'stats:product:export',
    load: () => import('./products/exports/route'),
  },
  {
    name: '交易统计',
    path: '/admin-api/stats/trade',
    permission: 'stats:trade:read',
    load: () => import('./trade/route'),
  },
  {
    name: '导出交易统计',
    path: '/admin-api/stats/trade/exports',
    permission: 'stats:trade:export',
    load: () => import('./trade/exports/route'),
  },
  {
    name: '订单统计',
    path: '/admin-api/stats/orders',
    permission: 'stats:order:read',
    load: () => import('./orders/route'),
  },
  {
    name: '销售看板',
    path: '/admin-api/stats/sales',
    permission: 'stats:sales:read',
    load: () => import('./sales/route'),
  },
  {
    name: '导出分类销售',
    path: '/admin-api/stats/sales/exports',
    permission: 'stats:sales:export',
    load: () => import('./sales/exports/route'),
  },
] as const;

const ATOMS = [...new Set(ROUTES.map((route) => route.permission))];

// ---------------------------------------------------------------------------
// auth, permission and wiring
// ---------------------------------------------------------------------------

describe('/admin-api/stats', () => {
  it.each(ROUTES)('$name 401s without a session', async ({ path, load }) => {
    const { GET } = await load();
    expect((await GET(get(path))).status).toBe(401);
  });

  it.each(ROUTES)('$name answers 200 for $permission', async ({ path, permission, load }) => {
    const headers = await adminCookie([permission]);
    const { GET } = await load();
    const response = await GET(get(path, headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toBeTypeOf('object');
  });

  it.each(ROUTES)('$name 403s for every other atom', async ({ path, permission, load }) => {
    const others = ATOMS.filter((atom) => atom !== permission);
    const headers = await adminCookie(others);
    const { GET } = await load();
    const response = await GET(get(path, headers));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FORBIDDEN');
  });

  /**
   * The home page's three statistics tiles are not a route of this domain's: they
   * are contributed to the system domain's `/admin-api/dashboard/header` by
   * importing `@shop/core/stats`, which happens as a module side effect through
   * `@shop/core/domains`. That is exactly the kind of registration that disappears
   * silently — a bundler dropping an unused namespace import is enough — so it is
   * asserted end to end, through the real route, rather than by poking the
   * registry.
   */
  it('contributes the three home-page tiles to the dashboard header', async () => {
    const headers = await adminCookie(['system:dashboard:read', 'stats:trade:read']);
    const { GET } = await import('../dashboard/header/route');
    const response = await GET(get('/admin-api/dashboard/header', headers));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.degraded).toEqual([]);
    expect(body.tiles.map((tile: { key: string }) => tile.key)).toEqual(
      expect.arrayContaining(['stats.revenue', 'stats.paidOrders', 'stats.newUsers']),
    );
  });

  it('withholds the tiles from an admin who may not open 交易统计', async () => {
    const headers = await adminCookie(['system:dashboard:read']);
    const { GET } = await import('../dashboard/header/route');
    const body = await (await GET(get('/admin-api/dashboard/header', headers))).json();
    // Missing, not zero: the home page must not be a way around the atom.
    expect(body.tiles.map((tile: { key: string }) => tile.key)).not.toContain('stats.revenue');
  });

  it('reads leave no audit row; exports leave one each (AUTH-013)', async () => {
    const headers = await adminCookie();
    for (const route of ROUTES) {
      const { GET } = await route.load();
      expect((await GET(get(route.path, headers))).status).toBe(200);
    }
    const audited = (await harness.ctx.db.select().from(auditLogs))
      // Sign-ins are audited too; this test is about the operation.
      .filter((row) => row.routeId !== 'auth.adminLogin')
      .map((row) => row.routeId)
      .sort();
    // Taking the data out of the shop is recorded; looking at it is not.
    expect(audited).toEqual(['stats.productExport', 'stats.salesExport', 'stats.tradeExport']);
  });
});

// ---------------------------------------------------------------------------
// the window
// ---------------------------------------------------------------------------

describe('the window', () => {
  it('refuses an inverted range with 422 STATS_RANGE_INVALID', async () => {
    const headers = await adminCookie(['stats:trade:read']);
    const { GET } = await import('./trade/route');
    const response = await GET(
      get(
        '/admin-api/stats/trade?from=2026-02-03T00:00:00%2B08:00&to=2026-02-01T00:00:00%2B08:00',
        headers,
      ),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'STATS_RANGE_INVALID' });
  });

  it('rejects an unparseable instant with 422 before the service runs', async () => {
    const headers = await adminCookie(['stats:trade:read']);
    const { GET } = await import('./trade/route');
    const response = await GET(get('/admin-api/stats/trade?from=yesterday', headers));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  });

  it('defaults to the last 30 Shanghai days, answered as the window it used', async () => {
    const headers = await adminCookie(['stats:order:read']);
    const { GET } = await import('./orders/route');
    const body = await (await GET(get('/admin-api/stats/orders', headers))).json();
    // NOW is 2026-02-04 10:00 Shanghai, so the window runs from Shanghai
    // midnight on 01-06 up to (not including) Shanghai midnight on 02-05.
    expect(body).toMatchObject({
      from: '2026-01-05T16:00:00.000Z', // 2026-01-06T00:00+08:00
      to: '2026-02-04T16:00:00.000Z', // 2026-02-05T00:00+08:00
    });
    expect(body.chart.bucket).toBe('day');
    expect(body.chart.buckets).toHaveLength(30);
  });
});

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

describe('exports', () => {
  it('hands back the CSV envelope, header row and all', async () => {
    const headers = await adminCookie(['stats:product:export']);
    const { GET } = await import('./products/exports/route');
    const body = await (
      await GET(get('/admin-api/stats/products/exports?sortBy=paidAmount&limit=20', headers))
    ).json();
    expect(body).toMatchObject({ contentType: 'text/csv', rowCount: 0, truncated: false });
    expect(body.filename).toMatch(/^商品统计-\d{4}-\d{2}-\d{2}(至\d{4}-\d{2}-\d{2})?\.csv$/);
    expect(body.content.split('\n')[0]).toContain('商品ID');
  });

  it('maps the export refusal to 422 STATS_EXPORT_TOO_LARGE', async () => {
    await harness.ctx.config.set(statsConfig, { exportMaxRows: 10 });
    const headers = await adminCookie(['stats:trade:export']);
    const { GET } = await import('./trade/exports/route');
    // The default window is 30 daily buckets, which is 30 rows over a cap of 10.
    const response = await GET(get('/admin-api/stats/trade/exports', headers));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'STATS_EXPORT_TOO_LARGE',
      details: { maxRows: 10, matched: 30 },
    });
  });
});
