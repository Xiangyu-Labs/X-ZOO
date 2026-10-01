import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { products } from '@shop/db/schema/catalog';
import { users } from '@shop/db/schema/user';
import {
  AdminAuthService,
  registerUserLookup,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import * as decor from '@shop/core/decor';
import { USER_CENTER_DEFAULT_VERSION } from '@shop/contracts/decor/defaults';
import { createTestCtx, fakeUserLookup, type TestCtx } from '@shop/testing';
import { setContainer, type Container } from '../../../../src/server/container';
import type { Env } from '../../../../src/server/env';

/**
 * `/api/v1/pages/*` — the storefront side of 页面装修 v2, as HTTP.
 *
 * The resolver's rules are proved in `packages/core/src/decor/decor.int.test.ts`.
 * Here: the three routes answer their contracts (responses are validated),
 * a page is public but personalised when a session comes with it, the ETag
 * turns an unchanged page into a 304 and changes with a publish, the client
 * headers reach the resolver, and a preview token opens a draft and nothing else.
 */

let harness: TestCtx;

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
    adminAuth: new AdminAuthService(harness.ctx, { bcryptCost: 4 }),
    userSessions: new UserSessionService(),
    close: async () => {},
  };
  setContainer(container);
}, 180_000);

afterAll(async () => {
  resetUserLookup();
  setContainer(undefined);
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  known.length = 0;
  harness.clock.set('2026-06-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Headers = Record<string, string>;

const get = (path: string, headers: Headers = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { 'x-client-platform': 'h5', ...headers } });

const admin = () => harness.as({ kind: 'admin', id: 1, permissions: [], isSuper: true });

const slide = { image: 'https://cdn.example.com/banner.jpg' };

function doc(blocks: unknown[]) {
  return {
    schemaVersion: 2 as const,
    root: { props: { title: '首页', background: '#f5f5f5', shareEnabled: true, shareTitle: '' } },
    blocks: blocks as { id: string; type: string; v: number; props: Record<string, unknown> }[],
  };
}

const banner = (id: string, visibility: Record<string, unknown> = {}) => ({
  id,
  type: 'carousel',
  v: 1,
  props: { slides: [slide], visibility },
});

async function product(): Promise<string> {
  const [row] = await harness.ctx.db
    .insert(products)
    .values({
      name: '商品',
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 50,
      freightMode: 'free',
      unitName: '件',
    })
    .returning({ id: products.id });
  return String(row!.id);
}

/** A document with `blocks` as its draft; published and designated as asked. */
async function page(
  kind: 'home' | 'user_center' | 'custom',
  blocks: unknown[],
  options: { publish?: boolean; designate?: boolean } = {},
): Promise<{ id: string; version: string }> {
  const ctx = admin();
  const created = await decor.createDocument(ctx, { kind, name: '页面' });
  const saved = await decor.saveDraft(ctx, {
    id: created.id,
    document: doc(blocks),
    version: created.draftVersion,
  });
  if (options.publish !== false) await decor.publish(ctx, { id: created.id, note: '' });
  if (options.designate && kind !== 'custom') {
    await decor.designate(ctx, { designation: kind, documentId: created.id });
  }
  return { id: created.id, version: saved.version };
}

const known: { id: number }[] = [];
const sessions = new UserSessionService();

async function shopperHeaders(): Promise<Headers> {
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `shopper-${known.length + 1}` })
    .returning({ id: users.id });
  known.push({ id: user!.id });
  registerUserLookup(fakeUserLookup([...known]));
  const issued = await sessions.issue(harness.ctx, {
    userId: user!.id,
    passwordVersion: 1,
    platform: 'h5',
  });
  return { authorization: `Bearer ${issued.token}` };
}

type PageBody = {
  id: string | null;
  version: string;
  preview: boolean;
  revision: number | null;
  personal: unknown;
  blocks: { id: string; type: string; data: Record<string, unknown> }[];
};

const idsOf = (body: PageBody) => body.blocks.map((block) => block.id);

// ---------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------

describe('GET /api/v1/pages/home', () => {
  it('404s with DECOR_HOME_NOT_SET until a home page is designated', async () => {
    const { GET } = await import('./home/route');
    const response = await GET(get('/api/v1/pages/home'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'DECOR_HOME_NOT_SET',
      message: '商城首页尚未设置',
    });
  });

  it('serves the live revision with its data resolved, and a weak ETag', async () => {
    const productId = await product();
    await page(
      'home',
      [
        banner('b'),
        {
          id: 'g',
          type: 'productGrid',
          v: 1,
          props: { source: { mode: 'manual', ids: [productId] } },
        },
      ],
      { designate: true },
    );
    const { GET } = await import('./home/route');
    const response = await GET(get('/api/v1/pages/home'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PageBody;
    expect(body).toMatchObject({ kind: 'home', revision: 1, preview: false, personal: null });
    expect(idsOf(body)).toEqual(['b', 'g']);
    expect(body.blocks[1]!.data.products).toEqual([
      { id: productId, title: '商品', image: 'https://cdn.example.com/p.jpg', price: '60.00' },
    ]);
    expect(response.headers.get('etag')).toMatch(/^W\/"/);
  });

  it('answers 304 to a matching If-None-Match, and a publish changes the ETag', async () => {
    const { id, version } = await page('home', [banner('one')], { designate: true });
    const { GET } = await import('./home/route');
    const first = await GET(get('/api/v1/pages/home'));
    const etag = first.headers.get('etag')!;

    // Resolved again (a new `resolvedAt`), still the same page.
    harness.clock.set('2026-06-01T00:05:00.000Z');
    await harness.redis.flushdb();
    const unchanged = await GET(get('/api/v1/pages/home', { 'if-none-match': etag }));
    expect(unchanged.status).toBe(304);

    await decor.saveDraft(admin(), { id, document: doc([banner('two')]), version });
    await decor.publish(admin(), { id, note: '' });
    const changed = await GET(get('/api/v1/pages/home', { 'if-none-match': etag }));
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(idsOf((await changed.json()) as PageBody)).toEqual(['two']);
  });

  it('filters blocks per request: session, X-Client-Platform, X-Client-Version', async () => {
    await page(
      'home',
      [
        banner('all'),
        banner('guests', { audience: 'guest' }),
        banner('members', { audience: 'member' }),
        banner('mini', { platforms: ['wechat-mini'] }),
      ],
      { designate: true },
    );
    const { GET } = await import('./home/route');

    const guest = (await (await GET(get('/api/v1/pages/home'))).json()) as PageBody;
    expect(idsOf(guest)).toEqual(['all', 'guests']);
    expect(guest.personal).toBeNull();

    const headers = await shopperHeaders();
    const member = (await (
      await GET(
        get('/api/v1/pages/home', {
          ...headers,
          'x-client-platform': 'wechat-mini',
          'x-client-version': '1.0.0',
        }),
      )
    ).json()) as PageBody;
    expect(idsOf(member)).toEqual(['all', 'members', 'mini']);
    expect(member.personal).toEqual({});
  });
});

describe('GET /api/v1/pages/user-center', () => {
  it('serves the built-in 个人中心 until one is designated, then that one', async () => {
    const { GET } = await import('./user-center/route');
    const builtin = (await (await GET(get('/api/v1/pages/user-center'))).json()) as PageBody;
    expect(builtin).toMatchObject({ id: null, version: USER_CENTER_DEFAULT_VERSION });
    expect(builtin.blocks.map((block) => block.type)).toEqual([
      'userCard',
      'orderEntry',
      'serviceGrid',
    ]);

    const { id } = await page('user_center', [{ id: 'card', type: 'userCard', v: 1, props: {} }], {
      designate: true,
    });
    const response = await GET(get('/api/v1/pages/user-center'));
    expect(response.status).toBe(200);
    const designated = (await response.json()) as PageBody;
    expect(designated).toMatchObject({ id, revision: 1 });
    expect(idsOf(designated)).toEqual(['card']);
  });
});

describe('GET /api/v1/pages/:id', () => {
  it('serves a published page; an unpublished or unknown one is a 404', async () => {
    const published = await page('custom', [banner('b')]);
    const draftOnly = await page('custom', [banner('b')], { publish: false });
    const { GET } = await import('./[id]/route');

    const ok = await GET(get(`/api/v1/pages/${published.id}`), {
      params: Promise.resolve({ id: published.id }),
    });
    expect(ok.status).toBe(200);
    expect(idsOf((await ok.json()) as PageBody)).toEqual(['b']);

    for (const id of [draftOnly.id, '999']) {
      const missing = await GET(get(`/api/v1/pages/${id}`), { params: Promise.resolve({ id }) });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { code: string }).code).toBe('DECOR_DOCUMENT_NOT_FOUND');
    }
  });

  it('with a preview token serves the draft of that document only', async () => {
    const mine = await page('custom', [banner('draft')], { publish: false });
    const other = await page('custom', [banner('other')]);
    const { previewToken } = await decor.createPreviewToken(admin(), { id: mine.id });
    const { GET } = await import('./[id]/route');

    const preview = await GET(
      get(`/api/v1/pages/${mine.id}?previewToken=${encodeURIComponent(previewToken)}`),
      { params: Promise.resolve({ id: mine.id }) },
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as PageBody;
    expect(body).toMatchObject({ preview: true, revision: null });
    expect(idsOf(body)).toEqual(['draft']);

    const elsewhere = await GET(
      get(`/api/v1/pages/${other.id}?previewToken=${encodeURIComponent(previewToken)}`),
      { params: Promise.resolve({ id: other.id }) },
    );
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({
      code: 'DECOR_PREVIEW_TOKEN_INVALID',
      message: '预览链接已失效，请重新生成',
    });
  });
});
