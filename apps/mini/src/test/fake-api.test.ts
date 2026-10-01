import { afterEach, describe, expect, it } from 'vitest';
import { contractMismatches, serveApi, type FakeHandler } from './fake-api';
import { taroFake } from './taro-fake/taro';

/**
 * `serveApi` is the mini's only way to answer a request, so it is where a stub that the server
 * could never send gets caught (AGENTS.md 20). Each case sends one request the way
 * `Taro.request` hands it over and reads what the helper recorded; `setup.ts` would fail the
 * test on the same records, so each case takes them first.
 */

const ok = { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 };
const added = () => ({ status: 201, body: {} });

async function send(
  routes: Record<string, FakeHandler>,
  method: string,
  url: string,
  data?: unknown,
): Promise<{ status: number; mismatches: string[] }> {
  serveApi(routes);
  const answer = await taroFake.onRequest({
    url: `https://shop.example${url}`,
    method,
    header: {},
    data: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: answer.statusCode, mismatches: contractMismatches.splice(0) };
}

afterEach(() => {
  contractMismatches.splice(0);
});

describe('serveApi (AGENTS 20)', () => {
  it('passes an exchange the contract allows', async () => {
    const { status, mismatches } = await send(
      { 'GET /api/v1/cart/count': () => ({ body: ok }) },
      'GET',
      '/api/v1/cart/count',
    );
    expect(status).toBe(200);
    expect(mismatches).toEqual([]);
  });

  it('refuses a stub for a route that does not exist', () => {
    expect(() => serveApi({ 'GET /api/v1/cart/total': () => ({ body: ok }) })).toThrow(
      /no storefront route/,
    );
    expect(() => serveApi({ 'POST /api/v1/cart/count': () => ({ body: ok }) })).toThrow(
      /no storefront route/,
    );
  });

  it('fails a request to a path no route has, and one nothing stubs', async () => {
    expect((await send({}, 'GET', '/api/v1/cart/total')).mismatches).toEqual([
      'GET /api/v1/cart/total: the page called a path no storefront route has',
    ]);
    const unstubbed = await send({}, 'GET', '/api/v1/cart/count');
    expect(unstubbed.status).toBe(404);
    expect(unstubbed.mismatches).toEqual(['GET /api/v1/cart/count: no stub answers it (serveApi)']);
  });

  it('fails a request the contract refuses: query, path params, body', async () => {
    const cart = { 'GET /api/v1/cart': () => ({ body: {} }) };
    expect((await send(cart, 'GET', '/api/v1/cart?pageSize=200')).mismatches).toContainEqual(
      expect.stringMatching(
        /^GET \/api\/v1\/cart: the page sent query cart\.list refuses: pageSize/,
      ),
    );
    expect(
      (
        await send(
          { 'DELETE /api/v1/cart/items/abc': () => ({ status: 204, body: null }) },
          'DELETE',
          '/api/v1/cart/items/abc',
        )
      ).mismatches,
    ).toContainEqual(expect.stringMatching(/sent path params cart\.removeItem refuses: id/));
    expect(
      (
        await send({ 'POST /api/v1/cart/items': added }, 'POST', '/api/v1/cart/items', {
          skuId: 21,
        })
      ).mismatches,
    ).toContainEqual(expect.stringMatching(/sent body cart\.addItem refuses: skuId/));
  });

  it('fails a success the route never answers', async () => {
    expect(
      (
        await send(
          { 'GET /api/v1/cart/count': () => ({ body: { items: '1' } }) },
          'GET',
          '/api/v1/cart/count',
        )
      ).mismatches,
    ).toEqual([expect.stringMatching(/the stub's body is not a cart\.count response/)]);
    expect(
      (
        await send(
          { 'POST /api/v1/cart/items': () => ({ status: 200, body: {} }) },
          'POST',
          '/api/v1/cart/items',
          { skuId: '21', quantity: 1 },
        )
      ).mismatches,
    ).toEqual(['POST /api/v1/cart/items: the stub answers 200, cart.addItem answers 201']);
  });

  it('fails an error the route never gives, or at the wrong status', async () => {
    const reply =
      (status: number, code: string): FakeHandler =>
      () => ({ status, body: { code, message: '失败' } });
    const post = (handler: FakeHandler) =>
      send({ 'POST /api/v1/cart/items': handler }, 'POST', '/api/v1/cart/items', {
        skuId: '21',
        quantity: 1,
      });

    expect((await post(reply(409, 'CART_OUT_OF_STOCK'))).mismatches).toEqual([]);
    expect((await post(reply(401, 'UNAUTHENTICATED'))).mismatches).toEqual([]);
    // handle() answers a foreign-key violation with these on any route.
    expect((await post(reply(409, 'REFERENCE_MISSING'))).mismatches).toEqual([]);
    expect((await post(reply(409, 'REFERENCE_IN_USE'))).mismatches).toEqual([]);
    expect((await post(reply(500, 'REFERENCE_IN_USE'))).mismatches).toEqual([
      'POST /api/v1/cart/items: REFERENCE_IN_USE is a 409, but the stub for cart.addItem answered 500',
    ]);
    expect((await post(reply(409, 'ORDER_OUT_OF_STOCK'))).mismatches).toEqual([
      'POST /api/v1/cart/items: cart.addItem does not declare ORDER_OUT_OF_STOCK in its errors; the server never answers it there',
    ]);
    expect((await post(reply(422, 'CART_OUT_OF_STOCK'))).mismatches).toEqual([
      'POST /api/v1/cart/items: CART_OUT_OF_STOCK is a 409, but the stub for cart.addItem answered 422',
    ]);
    expect((await post(() => ({ status: 400, body: 'bad' }))).mismatches).toEqual([
      'POST /api/v1/cart/items: cart.addItem: a 400 answer is not an error envelope { code, message }',
    ]);
  });

  it('lets through what comes from the proxy or the cache, not the handler', async () => {
    const count = (handler: FakeHandler) =>
      send({ 'GET /api/v1/cart/count': handler }, 'GET', '/api/v1/cart/count');
    expect((await count(() => ({ status: 304, body: null }))).mismatches).toEqual([]);
    expect(
      (await count(() => ({ status: 502, body: '<html>Bad Gateway</html>' }))).mismatches,
    ).toEqual([]);
    // An envelope at a gateway status is ours, and is checked.
    expect(
      (await count(() => ({ status: 503, body: { code: 'X', message: 'down' } }))).mismatches,
    ).toHaveLength(1);
  });

  it('hands the handler the request, query included', async () => {
    let keyword: string | undefined;
    await send(
      {
        'GET /api/v1/express-companies': (_body, request) => {
          keyword = request.query['keyword'];
          return { body: { items: [] } };
        },
      },
      'GET',
      '/api/v1/express-companies?keyword=%E4%B8%AD%E9%80%9A',
    );
    expect(keyword).toBe('中通');
  });
});
