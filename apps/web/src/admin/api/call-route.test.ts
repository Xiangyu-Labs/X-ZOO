import { defineRoute, id, pageQuery, paged } from '@shop/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { callRoute } from './call-route';
import { configureApi, resetApiConfig } from './config';
import { ApiError, CLIENT_ERROR_CODES, parseFieldErrors } from './errors';
import { routeKeyPrefix, routeQueryKey } from './query-keys';
import { uploadFile } from '../storage/upload';
import { buildPath, serialiseQuery } from './url';

const item = z.object({ id, name: z.string() });

const listRoute = defineRoute({
  id: 'test.list',
  method: 'GET',
  path: '/admin-api/things',
  auth: 'admin',
  permission: 'test:thing:list',
  summary: '列表',
  tags: ['test'],
  query: pageQuery.extend({ keyword: z.string().optional(), tag: z.array(z.string()).optional() }),
  response: paged(item),
  examples: [{ name: 'ok', response: { items: [], total: 0, page: 1, pageSize: 20 } }],
});

const detailRoute = defineRoute({
  id: 'test.detail',
  method: 'GET',
  path: '/admin-api/things/:id/notes/:noteId',
  auth: 'admin',
  permission: 'test:thing:read',
  summary: '详情',
  tags: ['test'],
  params: z.object({ id, noteId: id }),
  response: item,
  examples: [{ name: 'ok', params: { id: '1', noteId: '2' }, response: { id: '1', name: 'a' } }],
});

const createRoute = defineRoute({
  id: 'test.create',
  method: 'POST',
  path: '/admin-api/things',
  auth: 'admin',
  permission: 'test:thing:create',
  summary: '创建',
  tags: ['test'],
  body: z.object({ name: z.string() }),
  response: item,
  status: 201,
  examples: [{ name: 'ok', body: { name: 'a' }, response: { id: '1', name: 'a' } }],
});

const uploadRoute = defineRoute({
  id: 'test.upload',
  method: 'POST',
  path: '/admin-api/things/:id/files',
  auth: 'admin',
  permission: 'test:thing:create',
  summary: '上传',
  tags: ['test'],
  // A multipart route declares no `body`: `handle()` parses only JSON bodies,
  // so anything the caller may choose travels in `query`.
  params: z.object({ id }),
  query: z.object({ categoryId: z.string().optional() }),
  response: item,
  examples: [{ name: 'ok', params: { id: '1' }, response: { id: '9', name: 'a.png' } }],
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): {
  calls: { url: string; init?: RequestInit | undefined }[];
} {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  configureApi({
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return handler(url, init);
    },
  });
  return { calls };
}

afterEach(() => resetApiConfig());

describe('buildPath', () => {
  it('substitutes and encodes every placeholder', () => {
    expect(buildPath('/admin-api/things/:id/notes/:noteId', { id: '7', noteId: '9' })).toBe(
      '/admin-api/things/7/notes/9',
    );
    expect(buildPath('/admin-api/tags/:name', { name: 'a b/c' })).toBe('/admin-api/tags/a%20b%2Fc');
  });

  it('throws rather than sending a literal ":id"', () => {
    expect(() => buildPath('/admin-api/things/:id', {})).toThrow('缺少路径参数 :id');
    expect(() => buildPath('/admin-api/things/:id', { id: '' })).toThrow('缺少路径参数 :id');
  });
});

describe('serialiseQuery', () => {
  it('sorts keys, repeats arrays and drops empty values', () => {
    expect(
      serialiseQuery({
        page: 2,
        keyword: '',
        tag: ['a', 'b'],
        flag: true,
        gone: undefined,
        nil: null,
      }),
    ).toBe('?flag=true&page=2&tag=a&tag=b');
  });

  it('is stable regardless of property order', () => {
    expect(serialiseQuery({ b: 2, a: 1 })).toBe(serialiseQuery({ a: 1, b: 2 }));
  });

  it('encodes dates as ISO instants and objects as JSON', () => {
    const date = new Date('2026-03-01T02:00:00.000Z');
    expect(serialiseQuery({ at: date })).toBe('?at=2026-03-01T02%3A00%3A00.000Z');
    expect(serialiseQuery({ range: { min: 1 } })).toBe('?range=%7B%22min%22%3A1%7D');
  });

  it('returns an empty string when nothing survives', () => {
    expect(serialiseQuery({ a: undefined, b: '' })).toBe('');
    expect(serialiseQuery(undefined)).toBe('');
  });
});

describe('callRoute', () => {
  it('builds the URL from params and query', async () => {
    const { calls } = stubFetch(() => jsonResponse({ id: '1', name: 'a' }));
    await callRoute(detailRoute, { params: { id: '7', noteId: '9' } });
    expect(calls[0]?.url).toBe('/admin-api/things/7/notes/9');

    await callRoute(listRoute, { query: { page: 2, pageSize: 10, keyword: '搜' } });
    expect(calls[1]?.url).toBe('/admin-api/things?keyword=%E6%90%9C&page=2&pageSize=10');
  });

  it('sends cookies and a JSON body on writes', async () => {
    const { calls } = stubFetch(() => jsonResponse({ id: '1', name: 'a' }, 201));
    await callRoute(createRoute, { body: { name: '新建' } });
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.body).toBe(JSON.stringify({ name: '新建' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('never sends a body on GET', async () => {
    const { calls } = stubFetch(() => jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }));
    await callRoute(listRoute, { query: { page: 1, pageSize: 20 } });
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('maps an error body onto ApiError', async () => {
    stubFetch(() =>
      jsonResponse(
        { code: 'THING_LOCKED', message: '该记录已被锁定', details: { by: 'admin' } },
        409,
      ),
    );
    const error = await callRoute(detailRoute, { params: { id: '1', noteId: '2' } }).catch(
      (cause: unknown) => cause,
    );
    expect(ApiError.is(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, code: 'THING_LOCKED', message: '该记录已被锁定' });
  });

  it('falls back to a status message when the body is not an error body', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    const error = (await callRoute(listRoute, { query: { page: 1, pageSize: 20 } }).catch(
      (cause: unknown) => cause,
    )) as ApiError;
    expect(error.code).toBe('HTTP_502');
    expect(error.message).toBe('服务暂时不可用，请稍后再试');
  });

  it('turns a transport failure into a NETWORK_ERROR', async () => {
    configureApi({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const error = (await callRoute(listRoute, { query: { page: 1, pageSize: 20 } }).catch(
      (cause: unknown) => cause,
    )) as ApiError;
    expect(error.status).toBe(0);
    expect(error.code).toBe(CLIENT_ERROR_CODES.network);
  });

  it('calls onUnauthenticated for a 401, unless the caller opts out', async () => {
    const onUnauthenticated = vi.fn();
    stubFetch(() => jsonResponse({ code: 'UNAUTHENTICATED', message: '请先登录' }, 401));
    configureApi({ onUnauthenticated });

    await callRoute(listRoute, { query: { page: 1, pageSize: 20 } }).catch(() => {});
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    // The error goes along, so the login page can tell 登录已过期 from never signed in.
    expect(onUnauthenticated.mock.calls[0]?.[0]).toMatchObject({ code: 'UNAUTHENTICATED' });

    await callRoute(
      listRoute,
      { query: { page: 1, pageSize: 20 } },
      { onUnauthorized: 'throw' },
    ).catch(() => {});
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('validates the response against the contract when asked', async () => {
    stubFetch(() => jsonResponse({ items: [{ id: '1' }], total: 'lots', page: 1, pageSize: 20 }));
    const error = (await callRoute(
      listRoute,
      { query: { page: 1, pageSize: 20 } },
      { validateResponse: true },
    ).catch((cause: unknown) => cause)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.schema);
    // The route id is for the log, not the operator (AGENTS.md 1).
    expect(error.message).toBe('服务器返回的数据格式有误，请刷新后重试');
    expect(error.details).toMatchObject({ route: 'test.list' });
  });

  it('returns undefined for a 204', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(callRoute(createRoute, { body: { name: 'x' } })).resolves.toBeUndefined();
  });
});

describe('callRoute with FormData', () => {
  function form(): FormData {
    const data = new FormData();
    data.append('file', new File(['png-bytes'], 'a.png', { type: 'image/png' }));
    return data;
  }

  it('sends the FormData as-is and leaves Content-Type to the browser', async () => {
    const { calls } = stubFetch(() => jsonResponse({ id: '9', name: 'a.png' }));
    const data = form();
    await callRoute(uploadRoute, {
      params: { id: '7' },
      query: { categoryId: '3' },
      formData: data,
    });

    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe('/admin-api/things/7/files?categoryId=3');
    expect(init?.method).toBe('POST');
    // The browser generates the multipart boundary, so setting the header here
    // would produce a request the server cannot parse.
    expect(init?.headers as Record<string, string>).not.toHaveProperty('Content-Type');
    expect((init?.headers as Record<string, string>)['Accept']).toBe('application/json');
    expect(init?.body).toBe(data);
    expect(init?.credentials).toBe('include');
  });

  it('ignores body when formData is present', async () => {
    const { calls } = stubFetch(() => jsonResponse({ id: '9', name: 'a.png' }));
    const data = form();
    await callRoute(uploadRoute, { params: { id: '7' }, formData: data });
    expect(calls[0]?.init?.body).toBe(data);
  });

  it('maps an upload error the same way as any other route', async () => {
    stubFetch(() => jsonResponse({ code: 'STORAGE_FILE_TOO_LARGE', message: '文件过大' }, 413));
    const error = (await callRoute(uploadRoute, {
      params: { id: '7' },
      formData: form(),
    }).catch((cause: unknown) => cause)) as ApiError;
    expect(error.status).toBe(413);
    expect(error.code).toBe('STORAGE_FILE_TOO_LARGE');
  });

  it('still hands a 401 to onUnauthenticated', async () => {
    const onUnauthenticated = vi.fn();
    stubFetch(() => jsonResponse({ code: 'UNAUTHENTICATED', message: '请先登录' }, 401));
    configureApi({ onUnauthenticated });
    await callRoute(uploadRoute, { params: { id: '7' }, formData: form() }).catch(() => {});
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('maps an abort the same way as any other route', async () => {
    configureApi({
      fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    });
    const error = (await callRoute(uploadRoute, {
      params: { id: '7' },
      formData: form(),
    }).catch((cause: unknown) => cause)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.aborted);
  });

  it('validates the response against the contract like any other route', async () => {
    stubFetch(() => jsonResponse({ id: 9, name: 'a.png' }));
    const error = (await callRoute(
      uploadRoute,
      { params: { id: '7' }, formData: form() },
      { validateResponse: true },
    ).catch((cause: unknown) => cause)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.schema);
  });
});

describe('uploadFile', () => {
  it('builds the one-field form the server expects', async () => {
    const { calls } = stubFetch(() => jsonResponse({ id: '9', name: 'a.png' }));
    const file = new File(['png-bytes'], 'a.png', { type: 'image/png' });
    await uploadFile(uploadRoute, { params: { id: '7' }, query: { categoryId: '3' } }, file);

    const body = calls[0]?.init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBeInstanceOf(File);
    expect((body.get('file') as File).name).toBe('a.png');
    expect(calls[0]?.url).toBe('/admin-api/things/7/files?categoryId=3');
  });

  it('honours a custom field name', async () => {
    const { calls } = stubFetch(() => jsonResponse({ id: '9', name: 'a.png' }));
    const file = new File(['x'], 'b.png', { type: 'image/png' });
    await uploadFile(uploadRoute, { params: { id: '7' } }, file, { fieldName: 'attachment' });
    const body = calls[0]?.init?.body as FormData;
    expect(body.get('attachment')).toBeInstanceOf(File);
    expect(body.get('file')).toBeNull();
  });
});

describe('query keys', () => {
  it('starts with the route id so a route can be invalidated wholesale', () => {
    expect(routeQueryKey(listRoute, { query: { page: 1, pageSize: 20 } })[0]).toBe('test.list');
    expect(routeKeyPrefix(listRoute)).toEqual(['test.list']);
  });

  it('is stable across property order and drops undefined', () => {
    const a = routeQueryKey(listRoute, { query: { pageSize: 20, page: 1, keyword: undefined } });
    const b = routeQueryKey(listRoute, { query: { page: 1, pageSize: 20 } });
    expect(a).toEqual(b);
  });

  it('separates different inputs', () => {
    const a = routeQueryKey(listRoute, { query: { page: 1, pageSize: 20 } });
    const b = routeQueryKey(listRoute, { query: { page: 2, pageSize: 20 } });
    expect(a).not.toEqual(b);
  });

  it('is just the id when there is no input', () => {
    expect(routeQueryKey(listRoute)).toEqual(['test.list']);
  });
});

describe('parseFieldErrors', () => {
  it('understands zod flatten() and a raw issue list', () => {
    expect(parseFieldErrors({ fieldErrors: { name: ['必填'] } })).toEqual({ name: '必填' });
    expect(parseFieldErrors([{ path: ['sku', 0, 'price'], message: '价格不合法' }])).toEqual({
      'sku.0.price': '价格不合法',
    });
  });

  it('understands the `{ field, message }` list handle() sends on VALIDATION_FAILED', () => {
    const details = [
      { field: 'name', message: '名称至少 2 个字' },
      { field: 'sku.0.price', message: '价格不合法' },
      { field: 'sku.0.price', message: '价格必须大于 0' },
    ];
    expect(parseFieldErrors(details)).toEqual({
      name: '名称至少 2 个字',
      'sku.0.price': '价格不合法',
    });
    expect(
      new ApiError({ status: 422, code: 'VALIDATION_FAILED', message: '提交的数据有误', details })
        .fieldErrors,
    ).toEqual({
      name: '名称至少 2 个字',
      'sku.0.price': '价格不合法',
    });
  });

  it('leaves out the `<body>` entry, which names no field', () => {
    expect(parseFieldErrors([{ field: '<body>', message: '请求体不是合法的 JSON' }])).toBeNull();
  });

  it('returns null for anything else', () => {
    expect(parseFieldErrors(undefined)).toBeNull();
    expect(parseFieldErrors('boom')).toBeNull();
    expect(parseFieldErrors({})).toBeNull();
  });

  it('does not read a domain error’s own details as field messages', () => {
    // These reached the banner and the toast as they were: a code, an id, a
    // permission atom where the operator expected a reason.
    expect(parseFieldErrors({ reason: 'duplicate-name' })).toBeNull();
    expect(parseFieldErrors({ channel: 'wechatMini', missing: ['templateId'] })).toBeNull();
    expect(parseFieldErrors({ permissions: ['order:order:read'] })).toBeNull();
  });
});
