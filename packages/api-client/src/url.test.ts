import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchParamsToObject } from './test-support/handle-query';
import { buildPath, buildUrl, serialiseQuery } from './url';

describe('buildPath', () => {
  it('substitutes every :param, encoded', () => {
    expect(buildPath('/api/v1/orders/:id/payments', { id: '3001' })).toBe(
      '/api/v1/orders/3001/payments',
    );
    expect(buildPath('/api/v1/catalog/skus/:skuCode', { skuCode: 'A B/C' })).toBe(
      '/api/v1/catalog/skus/A%20B%2FC',
    );
    expect(buildPath('/api/v1/payments/:outTradeNo', { outTradeNo: 12 })).toBe(
      '/api/v1/payments/12',
    );
  });

  it('refuses a missing, null or empty param instead of sending ":id"', () => {
    expect(() => buildPath('/api/v1/orders/:id', {})).toThrow(/:id/);
    expect(() => buildPath('/api/v1/orders/:id', { id: null })).toThrow(/:id/);
    expect(() => buildPath('/api/v1/orders/:id', { id: '' })).toThrow(/:id/);
    expect(() => buildPath('/api/v1/orders/:id')).toThrow(/:id/);
  });

  it('leaves a path without params alone', () => {
    expect(buildPath('/api/v1/cart/count')).toBe('/api/v1/cart/count');
  });
});

describe('serialiseQuery', () => {
  it('is empty for no query, an empty one, or one with nothing to send', () => {
    expect(serialiseQuery()).toBe('');
    expect(serialiseQuery({})).toBe('');
    expect(serialiseQuery({ a: undefined, b: null, c: '' })).toBe('');
  });

  it('sorts keys so one input gives one URL', () => {
    expect(serialiseQuery({ pageSize: 20, page: 2, keyword: '手机' })).toBe(
      serialiseQuery({ keyword: '手机', page: 2, pageSize: 20 }),
    );
    expect(serialiseQuery({ b: 1, a: 2 })).toBe('?a=2&b=1');
  });

  it('writes booleans, numbers, dates and encodes the rest', () => {
    expect(
      serialiseQuery({
        unreadOnly: true,
        other: false,
        page: 3,
        at: new Date('2026-09-23T08:00:00.000Z'),
        keyword: 'a&b=c 手',
      }),
    ).toBe(
      '?at=2026-09-23T08%3A00%3A00.000Z&keyword=a%26b%3Dc%20%E6%89%8B&other=false&page=3&unreadOnly=true',
    );
  });

  it('repeats the key for an array and drops its empty members', () => {
    expect(serialiseQuery({ ids: ['12', '7', '', null, '31'] })).toBe('?ids=12&ids=7&ids=31');
  });

  it("is tested against handle()'s parser, not a stale copy of it", () => {
    const repo = path.resolve(import.meta.dirname, '../../..');
    const read = (file: string) => {
      const text = readFileSync(path.join(repo, file), 'utf8');
      const start = text.indexOf('export function searchParamsToObject');
      return text.slice(start, text.indexOf('\n}\n', start) + 2);
    };
    const original = read('apps/web/src/server/handle.ts');
    expect(original).toContain('searchParamsToObject');
    expect(read('packages/api-client/src/test-support/handle-query.ts')).toBe(original);
  });

  it("round-trips through handle()'s own parser", () => {
    const query = {
      page: 2,
      pageSize: 20,
      keyword: '红 色&x=1',
      ids: ['12', '7'],
      categoryIds: ['5'],
      unreadOnly: true,
      absent: undefined,
    };
    const url = buildUrl('https://shop.example', '/api/v1/catalog/products', undefined, query);
    const parsed = searchParamsToObject(new URL(url).searchParams);
    expect(parsed).toEqual({
      page: '2',
      pageSize: '20',
      keyword: '红 色&x=1',
      ids: ['12', '7'],
      // A one-element array comes back as a string: `idList` takes either.
      categoryIds: '5',
      unreadOnly: 'true',
    });
  });
});

describe('buildUrl', () => {
  it('joins base, path and query, and tolerates a trailing slash on the base', () => {
    expect(
      buildUrl('https://shop.example/', '/api/v1/orders/:id', { id: '9' }, { tab: 'unpaid' }),
    ).toBe('https://shop.example/api/v1/orders/9?tab=unpaid');
    expect(buildUrl('', '/api/v1/cart/count')).toBe('/api/v1/cart/count');
  });
});
