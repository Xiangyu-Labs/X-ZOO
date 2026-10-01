import { describe, expect, it, vi } from 'vitest';
import { createApiClient, routeMeta, type ApiClientOptions } from './client';
import { ApiError, isApiError, parseFieldErrors, toApiError } from './errors';
import { storefrontRouteList } from './routes.gen';
import { deferred, fakeTransport, json } from './test-support/fake-transport';
import { fetchTransport, taroTransport, type TaroRequestOption } from './transport';
import type { TransportResponse } from './transport';

function clientWith(
  respond: Parameters<typeof fakeTransport>[0],
  options: Partial<ApiClientOptions> = {},
) {
  const fake = fakeTransport(respond);
  const client = createApiClient({
    baseUrl: 'https://shop.example',
    transport: fake.transport,
    platform: 'wechat-mini',
    clientVersion: '1.4.0',
    getToken: () => 'tok-123',
    ...options,
  });
  return { client, requests: fake.requests };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('the route table', () => {
  it('holds storefront routes only: /api/v1, a shopper auth mode, no staff surface', () => {
    expect(storefrontRouteList.length).toBeGreaterThan(100);
    for (const route of storefrontRouteList) {
      expect(route.path.startsWith('/api/v1/')).toBe(true);
      expect(route.path).not.toMatch(/\/staff\//);
      expect(['public', 'user', 'user-optional']).toContain(route.auth);
      expect(Object.keys(route).sort()).toEqual(['auth', 'id', 'method', 'path']);
    }
  });

  it('looks a route up by id and refuses an unknown one', () => {
    expect(routeMeta('cart.addItem')).toEqual({
      id: 'cart.addItem',
      method: 'POST',
      path: '/api/v1/cart/items',
      auth: 'user',
    });
    expect(() => routeMeta('coupon.adminList' as never)).toThrow(/coupon\.adminList/);
  });
});

describe('client.call — the request', () => {
  it('builds the URL from path params and query, and sends no body on a GET', async () => {
    const { client, requests } = clientWith(() => json(200, { items: [] }));
    await client.call('catalog.productReviews', {
      params: { id: '42' },
      query: { page: 2, pageSize: 10 },
    });
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://shop.example/api/v1/catalog/products/42/reviews?page=2&pageSize=10',
      body: undefined,
    });
    expect(requests[0]?.headers['Content-Type']).toBeUndefined();
  });

  it('sends the body as JSON with its content type', async () => {
    const { client, requests } = clientWith(() => json(201, {}));
    await client.call('cart.addItem', { body: { skuId: '21', quantity: 2 } });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://shop.example/api/v1/cart/items',
      body: '{"skuId":"21","quantity":2}',
    });
    expect(requests[0]?.headers['Content-Type']).toBe('application/json');
  });

  it('sends a body on a DELETE too, as handle() reads one on any method whose route declares it', async () => {
    const { client, requests } = clientWith(() => ({ status: 204, headers: {}, body: '' }));
    // No storefront DELETE declares a body today; the cast stands in for one that will.
    const call = client.call as (id: string, input: unknown) => Promise<unknown>;
    await call('cart.removeItem', { params: { id: '9' }, body: { reason: 'x' } });
    expect(requests[0]).toMatchObject({ method: 'DELETE', body: '{"reason":"x"}' });
    expect(requests[0]?.headers['Content-Type']).toBe('application/json');
  });

  it('sets the platform, version and bearer headers', async () => {
    const { client, requests } = clientWith(() => json(200, {}));
    await client.call('user.getProfile');
    expect(requests[0]?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer tok-123',
      'X-Client-Platform': 'wechat-mini',
      'X-Client-Version': '1.4.0',
    });
  });

  it('sends the token to user-optional routes but never to public ones', async () => {
    const getToken = vi.fn(() => 'tok-123');
    const { client, requests } = clientWith(() => json(200, {}), { getToken });
    await client.call('catalog.productDetail', { params: { id: '1' } }); // user-optional
    await client.call('system.appConfigGet'); // public
    expect(requests[0]?.headers['Authorization']).toBe('Bearer tok-123');
    expect(requests[1]?.headers['Authorization']).toBeUndefined();
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('awaits an async token and sends none when signed out', async () => {
    let token: string | null = 'async-tok';
    const { client, requests } = clientWith(() => json(200, {}), {
      getToken: async () => token,
    });
    await client.call('cart.count');
    token = null;
    await client.call('cart.count');
    expect(requests[0]?.headers['Authorization']).toBe('Bearer async-tok');
    expect(requests[1]?.headers).not.toHaveProperty('Authorization');
  });

  it("lets a call add headers but not override the client's own", async () => {
    const { client, requests } = clientWith(() => json(200, {}));
    await client.call('cart.count', undefined, {
      headers: { 'X-Mock-Example': 'empty', 'X-Client-Platform': 'h5' },
    });
    expect(requests[0]?.headers['X-Mock-Example']).toBe('empty');
    expect(requests[0]?.headers['X-Client-Platform']).toBe('wechat-mini');
  });

  it('rejects a missing path param before anything is sent', async () => {
    const { client, requests } = clientWith(() => json(200, {}));
    await expect(client.call('order.detail', { params: {} as { id: string } })).rejects.toThrow(
      /:id/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe('client.call — the response', () => {
  it('resolves to the parsed body', async () => {
    const { client } = clientWith(() => json(200, { count: 3, selectedCount: 1 }));
    await expect(client.call('cart.count')).resolves.toEqual({ count: 3, selectedCount: 1 });
  });

  it('resolves a 204 to undefined without parsing', async () => {
    const { client } = clientWith(() => ({ status: 204, headers: {}, body: '' }));
    await expect(
      client.call('catalog.favoriteRemove', { params: { productId: '5' } }),
    ).resolves.toBeUndefined();
  });

  it('fails a 2xx whose body is not JSON with RESPONSE_PARSE_FAILED', async () => {
    const { client } = clientWith(() => ({ status: 200, headers: {}, body: '<html>' }));
    const error = await rejection(client.call('cart.count'));
    expect(error).toMatchObject({ status: 200, code: 'RESPONSE_PARSE_FAILED' });
  });

  it('hands a 2xx to the validator, and a validator throw fails the call', async () => {
    const validateResponse = vi.fn((_route: unknown, _status: number, payload: unknown) => {
      if ((payload as { count?: unknown }).count === 'bad') {
        throw new ApiError({ status: 200, code: 'RESPONSE_SCHEMA_MISMATCH', message: 'x' });
      }
    });
    let count: unknown = 1;
    const { client } = clientWith(() => json(200, { count }), { validateResponse });
    await client.call('cart.count');
    expect(validateResponse).toHaveBeenCalledWith(routeMeta('cart.count'), 200, { count: 1 });
    count = 'bad';
    const error = await rejection(client.call('cart.count'));
    expect(error.code).toBe('RESPONSE_SCHEMA_MISMATCH');
  });
});

describe('client.call — errors', () => {
  it('maps an error body to an ApiError carrying status, code, message, details and route', async () => {
    const { client } = clientWith(() =>
      json(409, {
        code: 'CART_OUT_OF_STOCK',
        message: '库存不足',
        details: { skuId: '21', available: 1 },
      }),
    );
    const error = await rejection(
      client.call('cart.addItem', { body: { skuId: '21', quantity: 2 } }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'CART_OUT_OF_STOCK',
      message: '库存不足',
      details: { skuId: '21', available: 1 },
      routeId: 'cart.addItem',
    });
    expect(isApiError(error, 'cart.addItem')).toBe(true);
    expect(isApiError(error, 'cart.count')).toBe(false);
  });

  it('falls back to HTTP_<status> for a body that is not an error body', async () => {
    const { client } = clientWith(() => ({ status: 502, headers: {}, body: '<html>Bad Gateway' }));
    const error = await rejection(client.call('cart.count'));
    expect(error).toMatchObject({
      status: 502,
      code: 'HTTP_502',
      message: '服务暂时不可用，请稍后再试',
    });
  });

  it("reads a 422's field errors in the shape handle() sends", async () => {
    const { client } = clientWith(() =>
      json(422, {
        code: 'VALIDATION_FAILED',
        message: '提交的数据有误',
        details: [
          { field: 'quantity', message: '数量至少为 1' },
          { field: 'quantity', message: 'second message loses' },
          { field: 'skuId', message: 'id 格式不正确' },
        ],
      }),
    );
    const error = await rejection(
      client.call('cart.addItem', { body: { skuId: 'x', quantity: 0 } }),
    );
    expect(error.fieldErrors).toEqual({ quantity: '数量至少为 1', skuId: 'id 格式不正确' });
  });

  it('maps a transport failure to NETWORK_ERROR with status 0', async () => {
    const { client } = clientWith(() => {
      throw { errMsg: 'request:fail timeout' };
    });
    const error = await rejection(client.call('cart.count'));
    expect(error).toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      details: 'request:fail timeout',
      routeId: 'cart.count',
    });
  });

  it('maps a failure after the signal aborted to REQUEST_ABORTED', async () => {
    const controller = new AbortController();
    const { client } = clientWith((req) => {
      controller.abort();
      expect(req.signal).toBe(controller.signal);
      throw new Error('aborted');
    });
    const error = await rejection(
      client.call('cart.count', undefined, { signal: controller.signal }),
    );
    expect(error).toMatchObject({ status: 0, code: 'REQUEST_ABORTED' });
  });

  it('passes an ApiError thrown by the transport through, stamped with the route', async () => {
    const { client } = clientWith(() => {
      throw new ApiError({ status: 0, code: 'METHOD_UNSUPPORTED', message: 'no PATCH' });
    });
    const error = await rejection(
      client.call('cart.updateItem', { params: { id: '1' }, body: { quantity: 2 } }),
    );
    expect(error).toMatchObject({ code: 'METHOD_UNSUPPORTED', routeId: 'cart.updateItem' });
  });
});

describe('client.call — 401', () => {
  const unauthenticated = () => json(401, { code: 'UNAUTHENTICATED', message: '请先登录' });

  it('calls onUnauthorized with the error, and still rejects', async () => {
    const onUnauthorized = vi.fn();
    const { client } = clientWith(unauthenticated, { onUnauthorized });
    const error = await rejection(client.call('cart.count'));
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(error);
  });

  it('calls it once for a burst of parallel 401s', async () => {
    const onUnauthorized = vi.fn();
    const held = deferred<TransportResponse>();
    const { client, requests } = clientWith(() => held.promise, { onUnauthorized });
    const calls = [
      client.call('cart.count'),
      client.call('user.getProfile'),
      client.call('order.counts'),
      client.call('notification.myUnreadCount'),
    ].map(rejection);
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    held.resolve(unauthenticated());
    const errors = await Promise.all(calls);
    expect(errors.map((e) => e.status)).toEqual([401, 401, 401, 401]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('fires again for a call made after it fired (the next sign-in expired too)', async () => {
    const onUnauthorized = vi.fn();
    const { client } = clientWith(unauthenticated, { onUnauthorized });
    await rejection(client.call('cart.count'));
    await rejection(client.call('cart.count'));
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('does not fire for any other status', async () => {
    const onUnauthorized = vi.fn();
    const { client } = clientWith(() => json(403, { code: 'FORBIDDEN', message: 'x' }), {
      onUnauthorized,
    });
    await rejection(client.call('cart.count'));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('toApiError / parseFieldErrors', () => {
  it('trusts only a { code, message } body', () => {
    expect(toApiError(404, { code: 'NOT_FOUND', message: '资源不存在' }).code).toBe('NOT_FOUND');
    expect(toApiError(404, { code: 1, message: 'x' }).code).toBe('HTTP_404');
    expect(toApiError(418, undefined)).toMatchObject({
      code: 'HTTP_418',
      message: '请求失败，请稍后再试',
    });
  });

  it('reads zod issues, a fieldErrors map and a flat map', () => {
    expect(parseFieldErrors([{ path: ['items', 0, 'quantity'], message: 'm' }])).toEqual({
      'items.0.quantity': 'm',
    });
    expect(parseFieldErrors({ fieldErrors: { name: ['必填', '其他'] } })).toEqual({ name: '必填' });
    expect(parseFieldErrors({ name: '必填' })).toEqual({ name: '必填' });
    expect(parseFieldErrors('nope')).toBeNull();
    expect(parseFieldErrors([])).toBeNull();
  });

  it('recognises an ApiError without instanceof (a transpiler that broke the prototype chain)', () => {
    const plain = { isApiError: true, status: 409, code: 'X', message: 'm', routeId: 'cart.count' };
    expect(isApiError(plain)).toBe(true);
    expect(isApiError(plain, 'cart.count')).toBe(true);
    expect(isApiError({ status: 409, code: 'X' })).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

describe('taroTransport', () => {
  function fakeTaro(result: {
    statusCode: number;
    data: unknown;
    header?: Record<string, unknown>;
  }) {
    const options: TaroRequestOption[] = [];
    const abort = vi.fn();
    const request = (option: TaroRequestOption) => {
      options.push(option);
      return Object.assign(Promise.resolve(result), { abort });
    };
    return { request, options, abort };
  }

  it('hands Taro.request the URL, method, headers and JSON text, and asks for text back', async () => {
    const taro = fakeTaro({
      statusCode: 201,
      data: '{"ok":true}',
      header: { 'Content-Type': 'application/json' },
    });
    const client = createApiClient({
      baseUrl: 'https://shop.example',
      transport: taroTransport(taro.request, {}),
      platform: 'wechat-mini',
      clientVersion: '1.0.0',
      getToken: () => 't',
      timeoutMs: 15_000,
    });
    await expect(
      client.call('cart.addItem', { body: { skuId: '1', quantity: 1 } }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(taro.options[0]).toEqual({
      url: 'https://shop.example/api/v1/cart/items',
      method: 'POST',
      header: {
        Accept: 'application/json',
        Authorization: 'Bearer t',
        'Content-Type': 'application/json',
        'X-Client-Platform': 'wechat-mini',
        'X-Client-Version': '1.0.0',
      },
      data: '{"skuId":"1","quantity":1}',
      dataType: 'text',
      responseType: 'text',
      timeout: 15_000,
    });
  });

  it('lower-cases response headers and re-serialises a body the runtime parsed anyway', async () => {
    const taro = fakeTaro({ statusCode: 200, data: { a: 1 }, header: { 'X-Request-Id': 'r1' } });
    const response = await taroTransport(taro.request)({
      url: 'u',
      method: 'GET',
      headers: {},
      body: undefined,
      signal: undefined,
      timeoutMs: undefined,
    });
    expect(response).toEqual({ status: 200, headers: { 'x-request-id': 'r1' }, body: '{"a":1}' });
  });

  it('refuses PATCH by default, which wx.request cannot send, and allows it when told', async () => {
    const taro = fakeTaro({ statusCode: 200, data: '{}' });
    const request = {
      url: 'u',
      method: 'PATCH',
      headers: {},
      body: '{}',
      signal: undefined,
      timeoutMs: undefined,
    } as const;
    await expect(taroTransport(taro.request)(request)).rejects.toMatchObject({
      code: 'METHOD_UNSUPPORTED',
    });
    expect(taro.options).toHaveLength(0);
    await expect(
      taroTransport(taro.request, { unsupportedMethods: [] })(request),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('aborts the task when the signal fires', async () => {
    const abort = vi.fn();
    let fail: (reason: unknown) => void = () => {};
    const request = () =>
      Object.assign(
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
        {
          abort: () => {
            abort();
            fail({ errMsg: 'request:fail abort' });
          },
        },
      );
    const controller = new AbortController();
    const client = createApiClient({
      baseUrl: '',
      transport: taroTransport(request),
      platform: 'wechat-mini',
      clientVersion: '1',
    });
    const pending = rejection(client.call('cart.count', undefined, { signal: controller.signal }));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('rejects a Taro fail result, which the client reports as NETWORK_ERROR', async () => {
    const request = () =>
      Object.assign(Promise.reject({ errMsg: 'request:fail ssl' }), { abort() {} });
    const client = createApiClient({
      baseUrl: '',
      transport: taroTransport(request),
      platform: 'wechat-mini',
      clientVersion: '1',
    });
    await expect(rejection(client.call('cart.count'))).resolves.toMatchObject({
      code: 'NETWORK_ERROR',
      details: 'request:fail ssl',
    });
  });
});

describe('fetchTransport', () => {
  it('passes method, headers, body and signal to fetch, and reads status, headers and text', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"id":"9"}', { status: 201, headers: { 'X-Request-Id': 'abc' } }),
    );
    const signal = new AbortController().signal;
    const response = await fetchTransport(fetchImpl)({
      url: 'https://shop.example/api/v1/orders',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
      timeoutMs: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://shop.example/api/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    });
    expect(response).toEqual({
      status: 201,
      headers: { 'x-request-id': 'abc', 'content-type': 'text/plain;charset=UTF-8' },
      body: '{"id":"9"}',
    });
  });
});
