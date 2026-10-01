/**
 * The client against the `@shop/testing` mock server, which answers each route
 * with a contract example and validates params, query and body against the
 * contract's zod schemas (a malformed request is a 422, as from `handle()`).
 *
 * So a pass here means: the client builds a URL and body the contract accepts
 * from the example's own input, the response comes back unchanged, and it
 * parses against the contract through `@shop/api-client/validate`.
 */
import type { AnyRouteDef, RouteExample } from '@shop/contracts/conventions';
import { startMockServer, type RunningMockServer } from '@shop/testing/mock-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from './client';
import { isApiError } from './errors';
import { storefrontRouteList } from './routes.gen';
import { fetchTransport } from './transport';
import type { RouteId } from './types';
import { contractOf, contractValidator } from './validate';

let server: RunningMockServer;
let client: ApiClient;

beforeAll(async () => {
  server = await startMockServer({ port: 0 });
  client = createApiClient({
    baseUrl: server.url,
    transport: fetchTransport(),
    platform: 'wechat-mini',
    clientVersion: 'contract-test',
    getToken: () => 'mock-token',
    validateResponse: contractValidator(),
  });
});

afterAll(async () => {
  await server.close();
});

/** Calls a route with an example's own input, asking the mock for that example's answer. */
function callExample(id: RouteId, example: RouteExample): Promise<unknown> {
  const call = client.call as (
    id: RouteId,
    input: unknown,
    options: { headers: Record<string, string> },
  ) => Promise<unknown>;
  return call(
    id,
    { params: example.params, query: example.query, body: example.body },
    // Example names are printable ASCII (checked below), so they fit a header as they are.
    { headers: { 'X-Mock-Example': example.name } },
  );
}

function firstExample(route: AnyRouteDef): RouteExample {
  const example = route.examples[0];
  if (!example) throw new Error(`${route.id} has no example`);
  return example;
}

/** One route per storefront domain, the journey a shopper takes. */
const REPRESENTATIVE: readonly RouteId[] = [
  'catalog.productList',
  'catalog.productDetail',
  'cart.addItem',
  'order.checkoutPreview',
  'order.create',
  'payment.start',
  'coupon.claimableList',
  'groupbuy.detail',
  'decor.pageHome',
  'system.appConfigGet',
  'user.getProfile',
];

describe('the client against the mock server', () => {
  it.each(REPRESENTATIVE)(
    '%s: the example input is accepted and its response validates',
    async (id) => {
      const route = contractOf(id);
      const example = firstExample(route);
      const response = await callExample(id, example);
      expect(response).toEqual(example.response);
      expect(route.response.safeParse(response).success).toBe(true);
    },
  );

  it('a 204 route resolves to undefined', async () => {
    const route = contractOf('catalog.favoriteRemove');
    expect(route.status).toBe(204);
    await expect(
      callExample('catalog.favoriteRemove', firstExample(route)),
    ).resolves.toBeUndefined();
  });

  it('an input the contract refuses comes back as a typed 422 with field errors', async () => {
    const error = await client
      .call('cart.addItem', { body: { skuId: 'not-an-id', quantity: 0 } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isApiError(error, 'cart.addItem')).toBe(true);
    if (!isApiError(error, 'cart.addItem')) return;
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(error.fieldErrors ?? {}).sort()).toEqual(['quantity', 'skuId']);
  });

  it('the validate entry fails a response that does not match its contract', async () => {
    const lying = createApiClient({
      baseUrl: server.url,
      // The mock's answer for cart.count, with a field of the wrong type.
      transport: async (request) => {
        const response = await fetchTransport()(request);
        const body = JSON.parse(response.body) as Record<string, unknown>;
        return { ...response, body: JSON.stringify({ ...body, items: 'three' }) };
      },
      platform: 'h5',
      clientVersion: 'contract-test',
      getToken: () => 'mock-token',
      validateResponse: contractValidator(),
    });
    await expect(lying.call('cart.count')).rejects.toMatchObject({
      code: 'RESPONSE_SCHEMA_MISMATCH',
      routeId: 'cart.count',
    });
  });

  // Every route in the table, every example: the whole storefront surface.
  const everyExample = storefrontRouteList.flatMap((meta) =>
    contractOf(meta.id).examples.map((example) => [meta.id, example.name] as const),
  );

  it('every example name can travel in the X-Mock-Example header', () => {
    for (const [id, name] of everyExample) expect(`${id} ${name}`).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each(everyExample)('sweep: %s [%s]', async (id, name) => {
    const route = contractOf(id);
    const example = route.examples.find((e) => e.name === name);
    if (!example) throw new Error(`${id}: no example ${name}`);
    const response = await callExample(id, example);
    expect(response).toEqual(route.status === 204 ? undefined : example.response);
  });
});
