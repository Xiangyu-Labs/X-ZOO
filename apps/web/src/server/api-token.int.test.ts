import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admins, auditLogs } from '@shop/db/schema/auth';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { configureAdminPasswords } from '@shop/core/system';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from './handle';
import { setContainer, type Container } from './container';
import type { Env } from './env';
import { createShopMcpEndpoint } from './mcp';

/**
 * API tokens end to end: a console admin mints one, an agent uses it as a
 * Bearer token on `/admin-api` and on `/mcp`, and an MCP client gets one
 * through the OAuth flow. Real routes, real PostgreSQL and Redis.
 */

let harness: TestCtx;

const ORIGIN = 'https://shop.example';
const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;

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
  harness = await createTestCtx();
  configureAdminPasswords({ bcryptCost: BCRYPT_COST });
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

async function seedAdmin(account = 'admin', isSuper = true): Promise<number> {
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account,
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: account,
      isSuper,
    })
    .returning({ id: admins.id });
  return admin!.id;
}

/** A console session, as the browser would hold it. */
async function consoleHeaders(account = 'admin'): Promise<Record<string, string>> {
  const { POST: login } = await import('../../app/admin-api/auth/login/route');
  const response = await login(
    request('POST', '/admin-api/auth/login', { account, password: PASSWORD }, SAME_ORIGIN),
  );
  const cookie = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  if (!cookie) throw new Error(`login failed: ${response.status}`);
  return { ...SAME_ORIGIN, cookie: `${ADMIN_COOKIE}=${cookie}` };
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function mintToken(headers: Record<string, string>, name = 'cli'): Promise<string> {
  const { POST } = await import('../../app/admin-api/api-tokens/route');
  const response = await POST(
    request('POST', '/admin-api/api-tokens', { name, expiresInDays: null }, headers),
  );
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { token: string; item: { hint: string } };
  expect(payload.token).toMatch(/^shp_[a-z2-9]{40}$/);
  expect(payload.token.startsWith(payload.item.hint)).toBe(true);
  return payload.token;
}

async function me(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import('../../app/admin-api/auth/me/route');
  return GET(request('GET', '/admin-api/auth/me', undefined, headers));
}

describe('a personal API token', () => {
  it('acts as its admin on /admin-api, with no cookie', async () => {
    const adminId = await seedAdmin();
    const token = await mintToken(await consoleHeaders());

    const response = await me(bearer(token));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: String(adminId), account: 'admin' });
  });

  it('skips the CSRF check — a token is not ambient — and audits the write with its id', async () => {
    await seedAdmin();
    const token = await mintToken(await consoleHeaders(), '老板的助手');
    const { POST } = await import('../../app/admin-api/user-groups/route');

    const response = await POST(
      request(
        'POST',
        '/admin-api/user-groups',
        { name: '高价值客户', sortOrder: 10 },
        {
          ...bearer(token),
          'sec-fetch-site': 'cross-site',
          origin: 'https://elsewhere.example',
        },
      ),
    );
    expect(response.status).toBe(201);

    const rows = (await harness.ctx.db.select().from(auditLogs)).filter(
      (row) => row.routeId === 'user.groupCreate',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiTokenId).not.toBeNull();
    expect(rows[0]!.adminAccount).toBe('admin');

    const { GET: list } = await import('../../app/admin-api/audit-logs/route');
    const logs = await list(
      request(
        'GET',
        '/admin-api/audit-logs?routeId=user.groupCreate',
        undefined,
        await consoleHeaders(),
      ),
    );
    expect((await logs.json()).items[0]).toMatchObject({ apiTokenName: '老板的助手' });
  });

  it('AUTH-012 — cannot create a role or an admin, nor save the payment settings', async () => {
    await seedAdmin();
    const token = await mintToken(await consoleHeaders());
    const { POST: createRole } = await import('../../app/admin-api/roles/route');
    const { POST: createAdmin } = await import('../../app/admin-api/admins/route');

    const role = await createRole(
      request('POST', '/admin-api/roles', { name: '后门' }, bearer(token)),
    );
    expect(role.status).toBe(403);
    expect((await role.json()).code).toBe('AUTH_TOKEN_CONSOLE_ONLY');

    const admin = await createAdmin(
      request(
        'POST',
        '/admin-api/admins',
        { account: 'backdoor', name: '后门', password: 'secret-pass-1', roleIds: [] },
        bearer(token),
      ),
    );
    expect(admin.status).toBe(403);
    expect((await admin.json()).code).toBe('AUTH_TOKEN_CONSOLE_ONLY');

    const { PUT: saveConfig } = await import('../../app/admin-api/system/config/[group]/route');
    const payment = await saveConfig(
      request('PUT', '/admin-api/system/config/payment', { values: {} }, bearer(token)),
      { params: Promise.resolve({ group: 'payment' }) },
    );
    expect(payment.status).toBe(403);
    expect((await payment.json()).code).toBe('AUTH_TOKEN_CONSOLE_ONLY');
  });

  it('cannot mint, list or revoke tokens itself', async () => {
    await seedAdmin();
    const token = await mintToken(await consoleHeaders());
    const { GET, POST } = await import('../../app/admin-api/api-tokens/route');

    const minted = await POST(
      request(
        'POST',
        '/admin-api/api-tokens',
        { name: 'spare', expiresInDays: null },
        bearer(token),
      ),
    );
    expect(minted.status).toBe(403);
    expect((await minted.json()).code).toBe('AUTH_TOKEN_CONSOLE_ONLY');
    expect(
      (await GET(request('GET', '/admin-api/api-tokens', undefined, bearer(token)))).status,
    ).toBe(403);
  });

  it('answers 401 for a token that is unknown, revoked, or outlived a password change', async () => {
    await seedAdmin();
    const headers = await consoleHeaders();
    expect((await me(bearer('shp_notarealtokennotarealtokennotarealtoke'))).status).toBe(401);

    const revoked = await mintToken(headers, 'a');
    const { GET: list } = await import('../../app/admin-api/api-tokens/route');
    const { DELETE: revoke } = await import('../../app/admin-api/api-tokens/[id]/route');
    const { items } = (await (
      await list(request('GET', '/admin-api/api-tokens', undefined, headers))
    ).json()) as {
      items: { id: string; name: string }[];
    };
    const target = items.find((item) => item.name === 'a')!;
    const revokedResponse = await revoke(
      request('DELETE', `/admin-api/api-tokens/${target.id}`, undefined, headers),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(revokedResponse.status).toBe(204);
    const refused = await me(bearer(revoked));
    expect(refused.status).toBe(401);
    expect((await refused.json()).code).toBe('AUTH_TOKEN_INVALID');

    const outlived = await mintToken(headers, 'b');
    expect((await me(bearer(outlived))).status).toBe(200);
    const { POST: changePassword } = await import('../../app/admin-api/profile/password/route');
    const changed = await changePassword(
      request(
        'POST',
        '/admin-api/profile/password',
        {
          currentPassword: PASSWORD,
          newPassword: 'another-pass-1',
          confirmPassword: 'another-pass-1',
        },
        headers,
      ),
    );
    expect(changed.status).toBe(200);
    expect((await me(bearer(outlived))).status).toBe(401);
  });

  it('shows an admin only their own tokens, and a super admin everyone’s', async () => {
    await seedAdmin('boss', true);
    await seedAdmin('clerk', false);
    const boss = await consoleHeaders('boss');
    const clerk = await consoleHeaders('clerk');
    await mintToken(boss, 'boss-token');
    await mintToken(clerk, 'clerk-token');
    const { GET } = await import('../../app/admin-api/api-tokens/route');

    const names = async (headers: Record<string, string>) =>
      (
        (await (await GET(request('GET', '/admin-api/api-tokens', undefined, headers))).json()) as {
          items: { name: string }[];
        }
      ).items
        .map((item) => item.name)
        .sort();
    expect(await names(clerk)).toEqual(['clerk-token']);
    expect(await names(boss)).toEqual(['boss-token', 'clerk-token']);
  });
});

describe('the MCP endpoint', () => {
  /** `call_operation` loops back to `/admin-api`; here the loop ends at the route module. */
  const loopback: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/admin-api/auth/me');
    const { GET } = await import('../../app/admin-api/auth/me/route');
    return GET(new Request(`${ORIGIN}${url.pathname}`, init));
  };

  async function rpc(token: string | null, method: string, params: unknown): Promise<Response> {
    const { getContainer } = await import('./container');
    const endpoint = createShopMcpEndpoint(getContainer, {
      internalOrigin: 'http://127.0.0.1:3000',
      fetch: loopback,
    });
    return endpoint(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...(token ? bearer(token) : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
  }

  /** The 2025-era transport answers a POST as a one-event SSE stream. */
  async function resultOf<T>(response: Response): Promise<T> {
    const text = await response.text();
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return (JSON.parse(data ?? text) as { result: T }).result;
  }

  it('sends an unauthenticated client to the OAuth metadata', async () => {
    const response = await rpc(null, 'tools/list', {});
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('lists its tools and runs an operation as the token’s admin', async () => {
    await seedAdmin();
    const token = await mintToken(await consoleHeaders());

    const listed = await rpc(token, 'tools/list', {});
    expect(listed.status).toBe(200);
    const { tools } = await resultOf<{ tools: { name: string }[] }>(listed);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'call_operation',
      'describe_operation',
      'search_operations',
      'whoami',
    ]);

    const called = await rpc(token, 'tools/call', {
      name: 'call_operation',
      arguments: { id: 'auth.adminMe' },
    });
    const result = await resultOf<{ isError?: boolean; content: { type: string; text: string }[] }>(
      called,
    );
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]!.text).toContain('"account": "admin"');
  });
});

describe('the OAuth flow an MCP client walks', () => {
  const REDIRECT = 'http://127.0.0.1:33418/callback';

  function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  async function register(): Promise<string> {
    const { POST } = await import('../../app/oauth/register/route');
    const response = await POST(
      request('POST', '/oauth/register', {
        client_name: 'Test Client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
  }

  async function authorize(clientId: string, challenge: string, decision: 'allow' | 'deny') {
    const { POST } = await import('../../app/oauth/authorize/decision/route');
    const form = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      decision,
    });
    const response = await POST(
      new Request(`${ORIGIN}/oauth/authorize/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(await consoleHeaders()),
        },
        body: form.toString(),
      }),
    );
    expect(response.status).toBe(303);
    return new URL(response.headers.get('location')!);
  }

  async function token(params: Record<string, string>): Promise<Response> {
    const { POST } = await import('../../app/oauth/token/route');
    return POST(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      }),
    );
  }

  it('advertises itself at the well-known addresses', async () => {
    const { GET: resource } = await import('../../app/oauth/metadata/resource/route');
    const { GET: server } = await import('../../app/oauth/metadata/server/route');
    expect(await (await resource()).json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
    });
    expect(await (await server()).json()).toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('trades a PKCE-checked code for tokens once, then rotates the refresh token', async () => {
    await seedAdmin();
    const clientId = await register();
    const { verifier, challenge } = pkce();

    const redirect = await authorize(clientId, challenge, 'allow');
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    const code = redirect.searchParams.get('code')!;

    const exchange = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
    };
    expect((await token({ ...exchange, code_verifier: pkce().verifier })).status).toBe(400);

    // A wrong verifier burned the code: codes are single-use, whatever the outcome.
    const { verifier: v2, challenge: c2 } = pkce();
    const code2 = (await authorize(clientId, c2, 'allow')).searchParams.get('code')!;
    const granted = await token({ ...exchange, code: code2, code_verifier: v2 });
    expect(granted.status).toBe(200);
    const first = (await granted.json()) as { access_token: string; refresh_token: string };
    expect(first.access_token).toMatch(/^shp_/);
    expect(first.refresh_token).toMatch(/^shr_/);
    expect((await me(bearer(first.access_token))).status).toBe(200);
    expect((await token({ ...exchange, code: code2, code_verifier: v2 })).status).toBe(400);
    expect(verifier).not.toBe(v2);

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await me(bearer(second.access_token))).status).toBe(200);
    expect((await me(bearer(first.access_token))).status).toBe(401);

    const replayed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(replayed.status).toBe(400);
  });

  it('sends a refusal back to the client as access_denied', async () => {
    await seedAdmin();
    const clientId = await register();
    const redirect = await authorize(clientId, pkce().challenge, 'deny');
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('code')).toBeNull();
  });

  it('AUTH-014 — writes allow and deny to 操作日志, naming the client and where the code went', async () => {
    await seedAdmin();
    const clientId = await register();
    await authorize(clientId, pkce().challenge, 'allow');
    await authorize(clientId, pkce().challenge, 'deny');

    const rows = (await harness.ctx.db.select().from(auditLogs))
      .filter((row) => row.routeId === 'oauth.authorizeDecision')
      .sort((a, b) => a.id - b.id);
    expect(rows.map((row) => JSON.parse(row.payload ?? '{}').decision)).toEqual(['allow', 'deny']);
    for (const row of rows) {
      expect(row.target).toBe(`oauth-client:${clientId}`);
      expect(row.adminId).not.toBeNull();
      expect(JSON.parse(row.payload ?? '{}')).toMatchObject({
        clientName: 'Test Client',
        redirectUri: REDIRECT,
      });
    }
  });

  it('refuses to register a client that would redirect somewhere unsafe', async () => {
    const { POST } = await import('../../app/oauth/register/route');
    const response = await POST(
      request('POST', '/oauth/register', {
        client_name: 'x',
        redirect_uris: ['javascript:alert(1)'],
      }),
    );
    expect(response.status).toBe(400);
  });
});
