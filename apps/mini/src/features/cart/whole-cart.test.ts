import { describe, expect, it } from 'vitest';
import { api } from '@/data/api';
import { cartItemFixture, cartListFixture } from '@/test/cart-fixture';
import { serveApi } from '@/test/fake-api';
import { readWholeCart } from './whole-cart';

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => cartItemFixture({ id: String(1000 + index) }));

/** A server holding `all` rows, paging them the way `cart.list` does. */
function serveCart(all: ReturnType<typeof rows>) {
  const seen = serveApi({
    'GET /api/v1/cart': () => {
      const query = seen[seen.length - 1]?.query ?? {};
      const page = Number(query.page ?? '1');
      const pageSize = Number(query.pageSize ?? '20');
      return {
        body: {
          ...cartListFixture(all),
          items: all.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
        },
      };
    },
  });
  return seen;
}

describe('the whole cart', () => {
  it('reads past the first 100 rows, page by page', async () => {
    const seen = serveCart(rows(230));
    const cart = await readWholeCart(api);
    expect(cart.items).toHaveLength(230);
    expect(cart.items[229]?.id).toBe('1229');
    expect(cart.total).toBe(230);
    expect(seen.map((request) => request.query.page)).toEqual(['1', '2', '3']);
  });

  it('asks once when one page holds it all', async () => {
    const seen = serveCart(rows(3));
    const cart = await readWholeCart(api);
    expect(cart.items).toHaveLength(3);
    expect(seen).toHaveLength(1);
  });
});
