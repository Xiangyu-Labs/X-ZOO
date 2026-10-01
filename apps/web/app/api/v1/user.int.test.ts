import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import {
  fakeSmsSender,
  registerSmsSender,
  resetSmsSender,
  type FakeSmsSender,
} from '@shop/core/sms';
import { smsConfig } from '@shop/core/system';
import { storefrontAuthConfig } from '@shop/core/user';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { userVisits } from '@shop/db/schema/stats';
import { users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';
import { ADMIN_COOKIE } from '../../../src/server/handle';

/**
 * The user and sign-in routes as HTTP, against a real database and Redis.
 *
 * The behaviour itself is pinned down in `@shop/core`; what a route file can
 * get wrong is narrower and is what this file proves: the contract is bound to
 * the right method and path, `auth` and `permission` are enforced before the
 * service runs, a body is validated before anything is written, the client IP
 * really reaches the throttle, and an admin write lands in `audit_logs`.
 *
 * Importing `@shop/core/user` for its side effect is what makes a storefront
 * token resolve at all: it installs the real `UserLookup`, where the other
 * route suites still register the fake.
 */

let harness: TestCtx;
let sms: FakeSmsSender;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;
const ORIGIN = 'https://shop.example';
const PHONE = '13800138000';

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
  sms = fakeSmsSender();
  registerSmsSender(sms);
  await harness.ctx.config.set(smsConfig, { templateVerifyCode: 'SMS_1' });
});

afterEach(() => {
  resetSmsSender();
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

/** Sign in through the real routes and keep the bearer token. */
async function shopper(
  ip = '203.0.113.7',
  phone = PHONE,
): Promise<{ token: string; headers: Record<string, string> }> {
  const { POST: sendCode } = await import('./auth/sms-codes/route');
  await sendCode(
    json('POST', '/api/v1/auth/sms-codes', { phone, scene: 'login' }, { 'x-real-ip': ip }),
  );
  const { POST: smsLogin } = await import('./auth/sessions/sms/route');
  const response = await smsLogin(
    json(
      'POST',
      '/api/v1/auth/sessions/sms',
      { phone, code: sms.lastCodeFor(phone) },
      { 'x-real-ip': ip },
    ),
  );
  // 201: the contract says a sign-in creates a session resource.
  expect(response.status).toBe(201);
  const body = await response.json();
  return { token: body.token, headers: { authorization: `Bearer ${body.token}` } };
}

/** An operator with exactly the permissions named, or a super admin with none named. */
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
      .values({ name: 'customer-operator' })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../../admin-api/auth/login/route');
  const response = await login(
    json('POST', '/admin-api/auth/login', { account: 'operator', password: PASSWORD }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

describe('POST /api/v1/auth/sms-codes', () => {
  it('sends a code anonymously and refuses the bound-account scenes', async () => {
    const { POST } = await import('./auth/sms-codes/route');

    const sent = await POST(
      json('POST', '/api/v1/auth/sms-codes', { phone: PHONE, scene: 'login' }),
    );
    // 202: the code is handed to the provider, not delivered by this response.
    expect(sent.status).toBe(202);
    expect(sms.sent).toHaveLength(1);

    const refused = await POST(
      json('POST', '/api/v1/auth/sms-codes', { phone: PHONE, scene: 'bind-phone' }),
    );
    expect(refused.status).toBe(401);
    expect((await refused.json()).code).toBe('UNAUTHENTICATED');
  });

  it('422s a phone number the schema refuses, without sending anything', async () => {
    const { POST } = await import('./auth/sms-codes/route');
    const response = await POST(
      json('POST', '/api/v1/auth/sms-codes', { phone: '1234', scene: 'login' }),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(sms.sent).toHaveLength(0);
  });

  it('counts the per-IP budget against the address the edge saw', async () => {
    // The edge sets `X-Real-IP` from its own view of the peer (after trusting
    // `X-Forwarded-For` only from Traefik), so that is the address counted.
    await harness.ctx.config.set(storefrontAuthConfig, { codePerIpPerDay: 10 });
    const { POST } = await import('./auth/sms-codes/route');
    const fromClient = (phone: string, client: string) =>
      POST(
        json('POST', '/api/v1/auth/sms-codes', { phone, scene: 'login' }, { 'x-real-ip': client }),
      );

    for (let i = 0; i < 10; i += 1) {
      expect((await fromClient(`1380013${8100 + i}`, '203.0.113.9')).status).toBe(202);
    }
    expect((await fromClient('13800138200', '203.0.113.9')).status).toBe(429);
    // The next shopper through the same proxy is unaffected.
    expect((await fromClient('13800138201', '203.0.113.10')).status).toBe(202);
  });

  it('ignores an X-Forwarded-For the client wrote itself', async () => {
    // The attack: a fresh made-up address per request, to get a fresh per-IP
    // budget each time. The edge's `X-Real-IP` is the one address that counts,
    // so every one of these is the same caller.
    await harness.ctx.config.set(storefrontAuthConfig, { codePerIpPerDay: 10 });
    const { POST } = await import('./auth/sms-codes/route');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await POST(
        json(
          'POST',
          '/api/v1/auth/sms-codes',
          { phone: `138001383${String(i).padStart(2, '0')}`, scene: 'login' },
          { 'x-real-ip': '203.0.113.50', 'x-forwarded-for': `198.51.100.${i + 1}` },
        ),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([...Array<number>(10).fill(202), 429, 429]);
    // Nor can a forged header pin that spent budget on somebody else.
    const other = await POST(
      json(
        'POST',
        '/api/v1/auth/sms-codes',
        { phone: '13800138399', scene: 'login' },
        { 'x-real-ip': '203.0.113.51', 'x-forwarded-for': '203.0.113.50' },
      ),
    );
    expect(other.status).toBe(202);
  });
});

describe('/api/v1/profile', () => {
  it('401s without a token and answers the caller with one', async () => {
    const { GET } = await import('./profile/route');
    expect((await GET(get('/api/v1/profile'))).status).toBe(401);

    const { headers } = await shopper();
    const response = await GET(get('/api/v1/profile', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phone: PHONE, hasPassword: false });
  });

  it('edits the nickname and refuses an empty one', async () => {
    const { PUT } = await import('./profile/route');
    const { headers } = await shopper();

    const ok = await PUT(json('PUT', '/api/v1/profile', { nickname: '小明' }, headers));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ nickname: '小明' });

    const bad = await PUT(json('PUT', '/api/v1/profile', { nickname: '' }, headers));
    expect(bad.status).toBe(422);
  });

  it('USER-019 — takes the avatar our upload returned and refuses one on another server', async () => {
    const { PUT } = await import('./profile/route');
    const { POST: upload } = await import('./uploads/route');
    const { headers } = await shopper();

    // What the mini-program does with `chooseAvatar`'s temporary file.
    const form = new FormData();
    const bytes = new Uint8Array(26);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(bytes.buffer).setUint32(16, 1, false);
    new DataView(bytes.buffer).setUint32(20, 1, false);
    form.append('file', new File([bytes as BlobPart], 'avatar.png', { type: 'image/png' }));
    const uploaded = await upload(
      new Request(`${ORIGIN}/api/v1/uploads?purpose=avatar`, {
        method: 'POST',
        body: form,
        headers: { 'sec-fetch-site': 'same-origin', ...headers },
      }),
    );
    expect(uploaded.status).toBe(201);
    const { url } = await uploaded.json();

    const ok = await PUT(json('PUT', '/api/v1/profile', { avatarUrl: url }, headers));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ avatarUrl: url });

    const foreign = await PUT(
      json('PUT', '/api/v1/profile', { avatarUrl: 'https://evil.example/pixel.png' }, headers),
    );
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toMatchObject({ code: 'USER_AVATAR_NOT_ALLOWED' });

    // Re-sending the current avatar, as every legacy save does, still passes.
    const again = await PUT(
      json('PUT', '/api/v1/profile', { nickname: '小红', avatarUrl: url }, headers),
    );
    expect(again.status).toBe(200);
  });
});

describe('/api/v1/invoice-titles', () => {
  const company = {
    headerType: 'company',
    name: '杭州某某科技有限公司',
    dutyNumber: '91330100MA2XXXXX0A',
  };

  it('401s without a token and 422s a company title with no 税号, writing nothing', async () => {
    const { GET, POST } = await import('./invoice-titles/route');
    expect((await GET(get('/api/v1/invoice-titles'))).status).toBe(401);
    expect((await POST(json('POST', '/api/v1/invoice-titles', company))).status).toBe(401);

    const { headers } = await shopper();
    const bad = await POST(
      json('POST', '/api/v1/invoice-titles', { headerType: 'company', name: '某某公司' }, headers),
    );
    expect(bad.status).toBe(422);
    const list = await GET(get('/api/v1/invoice-titles', headers));
    expect(await list.json()).toMatchObject({ total: 0, items: [] });
  });

  it('USER-018 — keeps every title route to its owner: a stranger gets 404 on all four', async () => {
    const { POST } = await import('./invoice-titles/route');
    const byId = await import('./invoice-titles/[id]/route');
    const { POST: setDefault } = await import('./invoice-titles/[id]/default/route');
    const { GET: getDefault } = await import('./invoice-titles/default/route');

    const owner = await shopper('203.0.113.7', PHONE);
    const created = await POST(json('POST', '/api/v1/invoice-titles', company, owner.headers));
    expect(created.status).toBe(201);
    const title = await created.json();
    expect(title).toMatchObject({ ...company, invoiceType: 'plain', isDefault: true });

    const stranger = await shopper('203.0.113.8', '13900139000');
    const path = `/api/v1/invoice-titles/${title.id}`;
    const params = { params: { id: String(title.id) } };
    const responses = [
      await byId.GET(get(path, stranger.headers), params),
      await byId.PUT(json('PUT', path, { ...company, name: '改掉' }, stranger.headers), params),
      await byId.DELETE(json('DELETE', path, undefined, stranger.headers), params),
      await setDefault(json('POST', `${path}/default`, {}, stranger.headers), params),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'USER_INVOICE_TITLE_NOT_FOUND' });
    }
    expect(
      await (await getDefault(get('/api/v1/invoice-titles/default', stranger.headers))).json(),
    ).toEqual({
      title: null,
    });

    // The owner still has it, unchanged, as the default.
    const mine = await getDefault(get('/api/v1/invoice-titles/default', owner.headers));
    expect(await mine.json()).toEqual({ title });
    const gone = await byId.DELETE(json('DELETE', path, undefined, owner.headers), params);
    expect(gone.status).toBe(204);
  });
});

describe('POST /api/v1/auth/phone/wechat-mini', () => {
  // What the WeChat exchange itself does is pinned against a fake
  // `api.weixin.qq.com` in `core/src/user/storefront-auth.mini.int.test.ts`.
  // The question here is narrower: is an anonymous caller refused before
  // anything reaches WeChat, and is the body checked before anything happens.
  it('401s without a token, 422s an empty code, and 409s an account that has a number', async () => {
    const { POST } = await import('./auth/phone/wechat-mini/route');

    const anonymous = await POST(
      json('POST', '/api/v1/auth/phone/wechat-mini', { phoneCode: 'mp-phone-code-abc' }),
    );
    expect(anonymous.status).toBe(401);

    const { headers } = await shopper();
    const empty = await POST(
      json('POST', '/api/v1/auth/phone/wechat-mini', { phoneCode: '' }, headers),
    );
    expect(empty.status).toBe(422);

    // The shopper signed in with an SMS code, so a number is already on the
    // account: the refusal comes before any WeChat call, and a perfectly good
    // single-use code is not spent finding that out.
    const bound = await POST(
      json('POST', '/api/v1/auth/phone/wechat-mini', { phoneCode: 'mp-phone-code-abc' }, headers),
    );
    expect(bound.status).toBe(409);
    expect((await bound.json()).code).toBe('AUTH_PHONE_ALREADY_BOUND');
  });
});

describe('DELETE /api/v1/auth/sessions/current', () => {
  it('revokes the bearer token it was called with, and only that one', async () => {
    const first = await shopper();
    await harness.redis.del(`sms:resend:login:${PHONE}`);
    const second = await shopper();

    const { DELETE } = await import('./auth/sessions/current/route');
    const response = await DELETE(
      json('DELETE', '/api/v1/auth/sessions/current', undefined, first.headers),
    );
    expect(response.status).toBe(200);

    const { GET } = await import('./profile/route');
    expect((await GET(get('/api/v1/profile', first.headers))).status).toBe(401);
    expect((await GET(get('/api/v1/profile', second.headers))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

describe('/admin-api/users', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('../../admin-api/users/route');
    expect((await GET(get('/admin-api/users?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/users?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('FORBIDDEN');
  });

  it('lists customers for an operator holding user:customer:read', async () => {
    await shopper();
    const headers = await adminCookie(['user:customer:read']);
    const { GET } = await import('../../admin-api/users/route');

    const response = await GET(get('/admin-api/users?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });

  it('disables an account, writes the audit row and kills the live token', async () => {
    const { headers: shopperHeaders } = await shopper();
    const [row] = await harness.ctx.db.select({ id: users.id }).from(users);
    const headers = await adminCookie(['user:customer:status']);
    const { POST } = await import('../../admin-api/users/[id]/status/route');

    const response = await POST(
      json('POST', `/admin-api/users/${row!.id}/status`, { status: 'disabled' }, headers),
      { params: { id: String(row!.id) } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'disabled' });

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ routeId: 'user.adminSetStatus', target: `user:${row!.id}` });

    // The ban takes effect on the session the shopper already holds.
    const { GET } = await import('./profile/route');
    expect((await GET(get('/api/v1/profile', shopperHeaders))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// the visits beacon
// ---------------------------------------------------------------------------

describe('POST /api/v1/visits', () => {
  it('takes a beacon with no session at all and answers 204 with no body', async () => {
    const { POST } = await import('./visits/route');
    const response = await POST(
      json(
        'POST',
        '/api/v1/visits',
        { path: '/pages/index/index' },
        {
          'x-real-ip': '198.51.100.4',
        },
      ),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');

    const [row] = await harness.ctx.db.select().from(userVisits);
    expect(row).toMatchObject({ userId: null, path: '/pages/index/index', ip: '198.51.100.4' });
  });

  it('attributes the row to the signed-in shopper when a token is sent', async () => {
    const { headers } = await shopper();
    const [user] = await harness.ctx.db.select({ id: users.id }).from(users);

    const { POST } = await import('./visits/route');
    const response = await POST(
      json('POST', '/api/v1/visits', { path: '/pages/goods_details/index' }, headers),
    );
    expect(response.status).toBe(204);

    const [row] = await harness.ctx.db.select().from(userVisits);
    expect(row!.userId).toBe(user!.id);
  });

  it('422s a path carrying a query string, before writing anything', async () => {
    // A beacon path is the route, not the URL: `?code=` off the WeChat OAuth
    // redirect and `?phone=` off a share link would turn this table into a
    // credential log nobody purges. The contract refuses it rather than the
    // service stripping it, so the client learns during development.
    const { POST } = await import('./visits/route');
    const response = await POST(
      json('POST', '/api/v1/visits', { path: '/pages/index/index?code=081abc' }),
    );
    expect(response.status).toBe(422);
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(0);
  });
  it('takes the hide report on the same route and credits the view, not a new one', async () => {
    const { POST } = await import('./visits/route');
    const beacon = (body: Record<string, unknown>) =>
      POST(json('POST', '/api/v1/visits', body, { 'x-real-ip': '198.51.100.4' }));

    expect((await beacon({ path: '/pages/index/index' })).status).toBe(204);
    harness.clock.advance(12_000);
    expect((await beacon({ path: '/pages/index/index', stayMs: 12_000 })).status).toBe(204);

    const rows = await harness.ctx.db.select().from(userVisits);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stayMs).toBe(12_000);
  });

  it('422s a stay that is negative, fractional or longer than a day', async () => {
    const { POST } = await import('./visits/route');
    for (const stayMs of [-1, 1.5, 86_400_001]) {
      const response = await POST(
        json('POST', '/api/v1/visits', { path: '/pages/index/index', stayMs }),
      );
      expect(response.status, String(stayMs)).toBe(422);
    }
  });
});
