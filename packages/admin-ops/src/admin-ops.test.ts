import { describe, expect, it } from 'vitest';
import { allRoutes } from '@shop/contracts/routes';
import {
  callOperation,
  describeOperation,
  fillPath,
  listOperations,
  OperationError,
  searchOperations,
  toSearch,
} from './index';

describe('the operation catalogue', () => {
  it('is every admin route but the ones an agent must not have', () => {
    const ids = new Set(listOperations().map((op) => op.id));
    const admin = allRoutes.filter((r) => r.path.startsWith('/admin-api/') && r.auth === 'admin');
    expect(ids.size).toBeGreaterThan(150);
    expect(ids.size).toBeLessThan(admin.length);
    for (const excluded of [
      'auth.apiTokenCreate',
      'auth.adminLogin',
      'system.profileChangePassword',
    ]) {
      expect(ids.has(excluded)).toBe(false);
    }
    expect([...ids].every((id) => !id.startsWith('health.'))).toBe(true);
  });

  it('AUTH-012 — leaves out every console-only route: admins, roles and tokens are not an agent’s to manage', () => {
    const ids = new Set(listOperations().map((op) => op.id));
    const consoleOnly = allRoutes.filter((r) => r.consoleOnly === true).map((r) => r.id);
    expect(consoleOnly).toEqual(
      expect.arrayContaining([
        'system.adminCreate',
        'system.adminResetPassword',
        'system.roleUpdate',
        'auth.apiTokenCreate',
        'payment.miniTradeSync',
      ]),
    );
    for (const id of consoleOnly) expect(ids.has(id)).toBe(false);
    // Reading them stays an operation.
    expect(ids.has('system.adminList')).toBe(true);
  });

  it.each([
    ['加个商品', 'catalog.adminProductCreate'],
    ['管理员列表', 'system.adminList'],
    ['改备案号', 'system.configSave'],
    ['保存草稿', 'decor.adminDraftSave'],
    ['从网址导入图片', 'storage.attachmentImport'],
    ['商品排行', 'stats.productRanking'],
  ])('finds %s', (query, id) => {
    expect(searchOperations(query, { limit: 8 }).map((op) => op.id)).toContain(id);
  });

  it('lists one domain', () => {
    const decor = searchOperations('', { domain: 'decor' });
    expect(decor.length).toBeGreaterThan(5);
    expect(decor.every((op) => op.domain === 'decor')).toBe(true);
  });

  it('describes an operation with JSON Schemas and the contract examples', () => {
    const detail = describeOperation('catalog.adminProductCreate');
    expect(detail?.method).toBe('POST');
    expect(detail?.body).toMatchObject({ type: 'object' });
    expect(detail?.examples[0]?.body).toMatchObject({ name: '经典白T恤' });
    expect(describeOperation('auth.apiTokenCreate')).toBeNull();
  });
});

describe('calling an operation', () => {
  it('fills the path and repeats array keys in the query', () => {
    expect(fillPath('/admin-api/roles/:id', { id: '3' })).toBe('/admin-api/roles/3');
    expect(() => fillPath('/admin-api/roles/:id', {})).toThrow(OperationError);
    expect(() => fillPath('/admin-api/roles/:id', { id: '3', page: '2' })).toThrow(/page/);
    expect(toSearch({ page: 1, tag: ['a', 'b'], skip: undefined })).toBe('?page=1&tag=a&tag=b');
  });

  it('sends the bearer token and the JSON body, and hands back the answer verbatim', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const result = await callOperation(
      {
        origin: 'https://shop.test/',
        token: 'shp_x',
        fetch: (async (url: string, init: RequestInit) => {
          seen.push({ url, init });
          return new Response(JSON.stringify({ code: 'VALIDATION_FAILED' }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
      'system.configSave',
      { params: { group: 'site' }, body: { values: { icpNumber: '粤ICP备1号' } } },
    );
    expect(seen[0]?.url).toBe('https://shop.test/admin-api/system/config/site');
    expect(seen[0]?.init.method).toBe('PUT');
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer shp_x');
    expect(seen[0]?.init.body).toBe('{"values":{"icpNumber":"粤ICP备1号"}}');
    expect(result).toEqual({ ok: false, status: 422, data: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses a body on a read, but lets an empty one through', async () => {
    const seen: RequestInit[] = [];
    const client = {
      origin: 'https://shop.test',
      token: 'shp_x',
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    };
    await expect(callOperation(client, 'system.roleList', { body: { page: 1 } })).rejects.toThrow(
      /GET/,
    );
    await expect(callOperation(client, 'system.roleList', { body: {} })).resolves.toMatchObject({
      ok: true,
    });
    expect(seen[0]?.body).toBeUndefined();
  });

  it('knows every upload route by name', () => {
    const uploads = listOperations().filter((op) => /multipart/i.test(op.summary));
    expect(uploads.map((op) => op.id)).toEqual(['storage.attachmentUpload']);
    expect(uploads.every((op) => op.multipart)).toBe(true);
  });

  it('refuses an unknown id and a file upload', async () => {
    const client = { origin: 'https://shop.test', token: 'shp_x' };
    await expect(callOperation(client, 'nope.nothing')).rejects.toThrow(OperationError);
    await expect(callOperation(client, 'storage.attachmentUpload')).rejects.toThrow(OperationError);
  });
});
