import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { attachments } from '@shop/db/schema/storage';
import { users } from '@shop/db/schema/user';
import {
  AdminAuthService,
  hashPassword,
  registerUserLookup,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import { createTestCtx, fakeUserLookup, type TestCtx } from '@shop/testing';
import { SCAN_UPLOADS_PER_IP_PER_HOUR } from '@shop/core/storage';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The `storage` routes as HTTP, against a real database.
 *
 * The upload routes are the only ones in the application that take
 * `multipart/form-data`, which `handle()` does not parse — they declare no
 * `body` and read the part themselves. That seam is the reason this file
 * exists: every rejection below (an executable, an HTML file, an SVG carrying a
 * script, a declared mime that does not match the bytes) happens after the
 * request has been accepted, and only an HTTP-level test proves it happens
 * at all.
 */

let harness: TestCtx;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;
const ORIGIN = 'https://shop.example';

const env: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'unused',
  REDIS_URL: 'unused',
  UPLOADS_DIR: '/tmp/uploads-int-test',
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
  harness = await createTestCtx({ now: '2026-09-22T08:00:00.000Z' });
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
  resetUserLookup();
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

/** A `multipart/form-data` POST, which is how every upload route is called. */
function upload(
  path: string,
  file: { bytes: Uint8Array; name: string; type: string },
  headers: Record<string, string> = {},
): Request {
  const form = new FormData();
  form.append('file', new File([file.bytes as BlobPart], file.name, { type: file.type }));
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    body: form,
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
  });
}

/** A 1×1 PNG: real magic bytes and a real IHDR, so the prober accepts it. */
function png(salt = 0): { bytes: Uint8Array; name: string; type: string } {
  const bytes = new Uint8Array(26);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1, false);
  view.setUint32(20, 1, false);
  bytes[25] = salt;
  return { bytes, name: 'banner.png', type: 'image/png' };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

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
      .values({ name: 'storage-operator' })
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

/** A storefront session, for the shopper-facing upload route. */
async function userSession(): Promise<Record<string, string>> {
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: 'shopper' })
    .returning({ id: users.id });
  registerUserLookup(fakeUserLookup([{ id: user!.id }]));
  const issued = await new UserSessionService().issue(harness.ctx, {
    userId: user!.id,
    passwordVersion: 1,
    platform: 'h5',
  });
  return { authorization: `Bearer ${issued.token}` };
}

// ---------------------------------------------------------------------------

describe('/admin-api/attachments', () => {
  it('401s without a session and 403s without the atom', async () => {
    const { GET } = await import('./route');
    expect((await GET(get('/admin-api/attachments?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['coupon:template:read']);
    const forbidden = await GET(get('/admin-api/attachments?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
  });

  it('uploads a PNG, stores it once, and dedupes the second copy', async () => {
    const headers = await adminCookie(['storage:attachment:write', 'storage:attachment:read']);
    const { POST } = await import('./route');

    const first = await POST(upload('/admin-api/attachments', png(), headers));
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body.deduped).toBe(false);
    expect(body.attachment).toMatchObject({ mime: 'image/png', kind: 'image', driver: 'local' });
    // The server chose the key; nothing in the request could influence it.
    expect(body.attachment.url).toMatch(/^\/uploads\//);

    const second = await POST(upload('/admin-api/attachments', png(), headers));
    expect((await second.json()).deduped).toBe(true);
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(1);
  });

  it('writes an audit row for an upload', async () => {
    const headers = await adminCookie(['storage:attachment:write']);
    const { POST } = await import('./route');
    await POST(upload('/admin-api/attachments', png(), headers));

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ routeId: 'storage.attachmentUpload', method: 'POST' });
  });

  describe('refuses what a naive uploader would accept', () => {
    const cases: Array<[string, { bytes: Uint8Array; name: string; type: string }]> = [
      [
        'a PHP web shell renamed to .png',
        { bytes: bytesOf('<?php system($_GET["c"]); ?>'), name: 'shell.png', type: 'image/png' },
      ],
      [
        'an HTML file (stored XSS on the upload origin)',
        {
          bytes: bytesOf('<html><script>alert(1)</script></html>'),
          name: 'x.html',
          type: 'text/html',
        },
      ],
      [
        'an SVG carrying a script',
        {
          bytes: bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          name: 'x.svg',
          type: 'image/svg+xml',
        },
      ],
      [
        'an ELF binary called a JPEG',
        {
          bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]),
          name: 'a.jpg',
          type: 'image/jpeg',
        },
      ],
      ['a PNG whose declared mime says JPEG', { ...png(), type: 'image/jpeg' }],
    ];

    for (const [label, file] of cases) {
      it(`refuses ${label}`, async () => {
        const headers = await adminCookie(['storage:attachment:write']);
        const { POST } = await import('./route');
        const response = await POST(upload('/admin-api/attachments', file, headers));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect((await response.json()).code).toMatch(/^STORAGE_/);
        expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
      });
    }
  });

  it('refuses a request with no file part at all', async () => {
    const headers = await adminCookie(['storage:attachment:write']);
    const { POST } = await import('./route');
    const response = await POST(
      new Request(`${ORIGIN}/admin-api/attachments`, {
        method: 'POST',
        body: new FormData(),
        headers: { 'sec-fetch-site': 'same-origin', ...headers },
      }),
    );
    expect(response.status).toBe(422);
  });

  it('renames, moves and deletes in bulk', async () => {
    const headers = await adminCookie();
    const { POST } = await import('./route');
    const created = await (await POST(upload('/admin-api/attachments', png(), headers))).json();
    const id = created.attachment.id;

    const { POST: createCategory } = await import('../attachment-categories/route');
    const category = await (
      await createCategory(
        json('POST', '/admin-api/attachment-categories', { name: '商品图', sortOrder: 0 }, headers),
      )
    ).json();

    const { PUT } = await import('./[id]/route');
    const renamed = await PUT(
      json('PUT', `/admin-api/attachments/${id}`, { name: '首页 banner' }, headers),
      { params: { id } },
    );
    expect((await renamed.json()).name).toBe('首页 banner');

    const { POST: moveMany } = await import('./moves/route');
    const moved = await moveMany(
      json('POST', '/admin-api/attachments/moves', { ids: [id], categoryId: category.id }, headers),
    );
    expect(await moved.json()).toMatchObject({ affected: 1, skippedIds: [] });

    const { POST: deleteMany } = await import('./deletions/route');
    const deleted = await deleteMany(
      json('POST', '/admin-api/attachments/deletions', { ids: [id] }, headers),
    );
    expect(await deleted.json()).toMatchObject({ affected: 1 });

    // Deleting twice is not an error: two operators, one list.
    const again = await deleteMany(
      json('POST', '/admin-api/attachments/deletions', { ids: [id] }, headers),
    );
    expect(await again.json()).toMatchObject({ affected: 0, skippedIds: [id] });
  });

  it('refuses to import from a private address, after resolving the name', async () => {
    const headers = await adminCookie(['storage:attachment:write']);
    const { POST } = await import('./imports/route');
    const response = await POST(
      json(
        'POST',
        '/admin-api/attachments/imports',
        { url: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/' },
        headers,
      ),
    );
    // The old `onlineUpload` called `file_get_contents($url)` and would have
    // handed back the instance's IAM credentials.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await response.json()).code).toBe('STORAGE_REMOTE_URL_REFUSED');
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });
});

describe('/admin-api/attachment-categories', () => {
  it('refuses to delete a folder that still holds files', async () => {
    const headers = await adminCookie();
    const { POST: createCategory } = await import('../attachment-categories/route');
    const category = await (
      await createCategory(
        json('POST', '/admin-api/attachment-categories', { name: '商品图', sortOrder: 0 }, headers),
      )
    ).json();

    const { POST } = await import('./route');
    await POST(upload(`/admin-api/attachments?categoryId=${category.id}`, png(), headers));

    const { DELETE } = await import('../attachment-categories/[id]/route');
    const response = await DELETE(
      json('DELETE', `/admin-api/attachment-categories/${category.id}`, undefined, headers),
      { params: { id: category.id } },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('STORAGE_CATEGORY_NOT_EMPTY');
  });
});

describe('scan-to-upload', () => {
  it('mints a token, accepts one phone, and refuses the second', async () => {
    const headers = await adminCookie();
    const { POST: mint } = await import('./scan-tokens/route');
    const token = await (
      await mint(json('POST', '/admin-api/attachments/scan-tokens', {}, headers))
    ).json();
    expect(token.url).toContain(token.token);

    // The phone has no session: the token in the path is the only credential.
    const { POST: scanUpload } =
      await import('../../api/v1/attachments/scan-uploads/[token]/route');
    const first = await scanUpload(
      upload(`/api/v1/attachments/scan-uploads/${token.token}`, png()),
      { params: { token: token.token } },
    );
    expect(first.status).toBe(201);

    const second = await scanUpload(
      upload(`/api/v1/attachments/scan-uploads/${token.token}`, png(1)),
      { params: { token: token.token } },
    );
    // One global token would have taken this too.
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect((await second.json()).code).toBe('STORAGE_SCAN_TOKEN_INVALID');

    const { GET: status } = await import('./scan-tokens/[token]/route');
    const polled = await status(get(`/admin-api/attachments/scan-tokens/${token.token}`, headers), {
      params: { token: token.token },
    });
    expect((await polled.json()).state).toBe('used');
  });

  it('throttles the public endpoint per client address, before the code is looked at', async () => {
    const { POST: scanUpload } =
      await import('../../api/v1/attachments/scan-uploads/[token]/route');
    const from = (ip: string, n: number) => {
      const token = `made-up-token-${String(n).padStart(8, '0')}`;
      return scanUpload(
        upload(`/api/v1/attachments/scan-uploads/${token}`, png(), { 'x-real-ip': ip }),
        { params: { token } },
      );
    };

    for (let i = 0; i < SCAN_UPLOADS_PER_IP_PER_HOUR; i += 1) {
      const response = await from('203.0.113.20', i);
      expect((await response.json()).code).toBe('STORAGE_SCAN_TOKEN_INVALID');
    }
    const limited = await from('203.0.113.20', 999);
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe('STORAGE_UPLOAD_RATE_LIMITED');

    // A client-written X-Forwarded-For buys no fresh bucket…
    const spoofed = await scanUpload(
      upload('/api/v1/attachments/scan-uploads/made-up-token-spoofed0', png(), {
        'x-real-ip': '203.0.113.20',
        'x-forwarded-for': '198.51.100.9',
      }),
      { params: { token: 'made-up-token-spoofed0' } },
    );
    expect(spoofed.status).toBe(429);
    // …and the next phone is not held up by somebody else's.
    const other = await from('203.0.113.21', 1000);
    expect((await other.json()).code).toBe('STORAGE_SCAN_TOKEN_INVALID');
  });

  it('reads another admin’s token as expired rather than as somebody else’s', async () => {
    const mine = await adminCookie();
    const { POST: mint } = await import('./scan-tokens/route');
    const token = await (
      await mint(json('POST', '/admin-api/attachments/scan-tokens', {}, mine))
    ).json();

    // A second, real admin with a real session.
    await harness.ctx.db.insert(admins).values({
      account: 'other',
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: '别人',
      isSuper: true,
    });
    const { POST: login } = await import('../auth/login/route');
    const response = await login(
      json('POST', '/admin-api/auth/login', { account: 'other', password: PASSWORD }),
    );
    const value = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
      response.headers.get('set-cookie') ?? '',
    )?.[1];

    const { GET: status } = await import('./scan-tokens/[token]/route');
    const polled = await status(
      get(`/admin-api/attachments/scan-tokens/${token.token}`, {
        cookie: `${ADMIN_COOKIE}=${value}`,
      }),
      { params: { token: token.token } },
    );
    // Not "pending, belongs to someone else": an admin has no business
    // learning that another admin's QR code is on a screen somewhere.
    expect((await polled.json()).state).toBe('expired');
  });
});

describe('/api/v1/uploads', () => {
  it('requires a shopper session', async () => {
    const { POST } = await import('../../api/v1/uploads/route');
    const response = await POST(upload('/api/v1/uploads?purpose=avatar', png()));
    expect(response.status).toBe(401);
  });

  it('accepts an avatar and answers with the file, not the library row', async () => {
    const headers = await userSession();
    const { POST } = await import('../../api/v1/uploads/route');
    const response = await POST(upload('/api/v1/uploads?purpose=avatar', png(), headers));
    expect(response.status).toBe(201);
    const body = await response.json();
    // No id, no driver, no sha256: a shopper has no business with the library.
    expect(Object.keys(body).sort()).toEqual(['height', 'mime', 'name', 'size', 'url', 'width']);
  });

  it('refuses a purpose that is not one of the three', async () => {
    const headers = await userSession();
    const { POST } = await import('../../api/v1/uploads/route');
    const response = await POST(upload('/api/v1/uploads?purpose=backup', png(), headers));
    expect(response.status).toBe(422);
  });

  it('refuses an executable from a shopper too', async () => {
    const headers = await userSession();
    const { POST } = await import('../../api/v1/uploads/route');
    const response = await POST(
      upload(
        '/api/v1/uploads?purpose=review',
        { bytes: bytesOf('<?php echo 1; ?>'), name: 'a.jpg', type: 'image/jpeg' },
        headers,
      ),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await harness.ctx.db.select().from(attachments)).toHaveLength(0);
  });
});
