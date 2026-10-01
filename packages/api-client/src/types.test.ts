/**
 * Type-level tests. `tsc` (the package's `typecheck`) is what fails on these:
 * every `expectTypeOf` and `@ts-expect-error` below is a compile-time
 * assertion. The `it` bodies only run so Vitest has something to report.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { ApiClient } from './client';
import { isApiError } from './errors';
import type {
  ContractOf,
  ErrorCodeOf,
  InputOf,
  PagedRouteId,
  PageItemOf,
  RequiresInput,
  ResponseOf,
  RouteId,
} from './types';

/** Typed like the real client; its calls never settle, since only their types are under test. */
const client = { call: () => new Promise(() => {}) } as unknown as ApiClient;

describe('route ids', () => {
  it('are the storefront ones only', () => {
    expectTypeOf<'catalog.productList'>().toExtend<RouteId>();
    expectTypeOf<'coupon.adminList'>().not.toExtend<RouteId>();
    expectTypeOf<'order.staffMe'>().not.toExtend<RouteId>();
    expectTypeOf<'payment.wechatNotify'>().not.toExtend<RouteId>();
    // @ts-expect-error an admin route is not callable
    void client.call('coupon.adminList');
  });
});

describe('input', () => {
  it('is required exactly when the route has a required part', () => {
    expectTypeOf<RequiresInput<'cart.count'>>().toEqualTypeOf<false>();
    expectTypeOf<RequiresInput<'catalog.productList'>>().toEqualTypeOf<false>();
    expectTypeOf<RequiresInput<'cart.addItem'>>().toEqualTypeOf<true>();
    expectTypeOf<RequiresInput<'catalog.productDetail'>>().toEqualTypeOf<true>();
    // @ts-expect-error cart.addItem needs a body
    void client.call('cart.addItem');
    void client.call('cart.count');
    void client.call('catalog.productList');
  });

  it("is each part's z.input", () => {
    expectTypeOf<InputOf<'catalog.productDetail'>['params']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<NonNullable<InputOf<'cart.addItem'>['body']>>().toEqualTypeOf<
      z.input<NonNullable<ContractOf<'cart.addItem'>['body']>>
    >();
    // @ts-expect-error ids are decimal strings, not numbers
    void client.call('catalog.productDetail', { params: { id: 1 } });
    // @ts-expect-error unknown query key
    void client.call('catalog.productList', { query: { nope: 1 } });
  });

  it('refuses a part the route does not declare', () => {
    // @ts-expect-error cart.count takes no body
    void client.call('cart.count', { body: { a: 1 } });
    // @ts-expect-error cart.addItem takes no params
    void client.call('cart.addItem', { params: { id: '1' }, body: { skuId: '1', quantity: 1 } });
  });
});

describe('response', () => {
  it('is the response schema, as the wire carries it', () => {
    expectTypeOf(client.call('cart.count')).resolves.toEqualTypeOf<
      z.input<ContractOf<'cart.count'>['response']>
    >();
    expectTypeOf<ResponseOf<'catalog.productDetail'>['id']>().toEqualTypeOf<string>();
  });

  it('is void for a 204 route', () => {
    expectTypeOf<ResponseOf<'catalog.favoriteRemove'>>().toEqualTypeOf<void>();
  });

  it('is z.input where a response schema has a default: the field may be absent', () => {
    // `ResponseOf` is `z.input` because that is what `handle()` sends. This
    // lists the routes where it differs from `z.output` (a `.default()` or a
    // transform in a response schema). One today: `checkoutPreview` has
    // `customFormFields: z.array(...).default([])`, so a service may omit it.
    type Differs<K extends RouteId> = [z.input<ContractOf<K>['response']>] extends [
      z.output<ContractOf<K>['response']>,
    ]
      ? [z.output<ContractOf<K>['response']>] extends [z.input<ContractOf<K>['response']>]
        ? never
        : K
      : K;
    type Mismatched = { [K in RouteId]: Differs<K> }[RouteId];
    expectTypeOf<Mismatched>().toEqualTypeOf<'order.checkoutPreview'>();
    expectTypeOf<ResponseOf<'order.checkoutPreview'>>()
      .toHaveProperty('customFormFields')
      .toExtend<unknown[] | undefined>();
    expectTypeOf<undefined>().toExtend<ResponseOf<'order.checkoutPreview'>['customFormFields']>();
  });
});

describe('error codes', () => {
  it("are the route's declared codes plus the common and client ones", () => {
    expectTypeOf<'PAYMENT_ORDER_EXPIRED'>().toExtend<ErrorCodeOf<'payment.start'>>();
    expectTypeOf<'UNAUTHENTICATED'>().toExtend<ErrorCodeOf<'payment.start'>>();
    expectTypeOf<'NETWORK_ERROR'>().toExtend<ErrorCodeOf<'payment.start'>>();
    expectTypeOf<'HTTP_502'>().toExtend<ErrorCodeOf<'payment.start'>>();
    expectTypeOf<'CART_OUT_OF_STOCK'>().not.toExtend<ErrorCodeOf<'payment.start'>>();
  });

  it('narrow through isApiError(error, routeId)', () => {
    const error: unknown = null;
    if (isApiError(error, 'cart.addItem')) {
      void (error.code === 'CART_OUT_OF_STOCK');
      // @ts-expect-error not a code cart.addItem declares
      void (error.code === 'CART_TYPO');
    }
    if (isApiError(error)) expectTypeOf(error.code).toEqualTypeOf<string>();
  });
});

describe('paged routes', () => {
  it('are the GET routes answering paged(...) with a page in the query', () => {
    expectTypeOf<'catalog.productList'>().toExtend<PagedRouteId>();
    expectTypeOf<'order.list'>().toExtend<PagedRouteId>();
    expectTypeOf<'groupbuy.openGroups'>().toExtend<PagedRouteId>();
    expectTypeOf<'cart.count'>().not.toExtend<PagedRouteId>();
    // POST, and its query has no page: a paged answer, not a paged list.
    expectTypeOf<'cart.setSelection'>().not.toExtend<PagedRouteId>();
    expectTypeOf<PageItemOf<'catalog.productList'>['id']>().toEqualTypeOf<string>();
  });

  it('take page and pageSize as a number or a string, and nothing else', () => {
    expectTypeOf<NonNullable<InputOf<'order.list'>['query']>['page']>().toEqualTypeOf<
      number | string | undefined
    >();
    void client.call('order.list', { query: { page: 2, pageSize: '20' } });
    // @ts-expect-error an object is not a page number
    void client.call('order.list', { query: { page: {} } });
  });
});
