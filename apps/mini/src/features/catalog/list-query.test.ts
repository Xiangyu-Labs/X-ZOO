import { describe, expect, it } from 'vitest';
import { categoryTreeFixture } from '@/test/catalog-fixture';
import { listQuery, moneyOf, nextPriceSort, normalisePrice, NO_PRICE } from './list-query';

describe('商品列表 query', () => {
  it('lists a known category’s subtree, and an unknown one by itself', () => {
    expect(
      listQuery({ categoryId: '12', sort: 'default', price: NO_PRICE, tree: categoryTreeFixture }),
    ).toEqual({ pageSize: 20, categoryIds: ['12', '121'] });
    expect(listQuery({ categoryId: '99', sort: 'default', price: NO_PRICE })).toEqual({
      pageSize: 20,
      categoryId: '99',
    });
  });

  it('maps each sort to the API’s sortBy / sortOrder', () => {
    const q = (sort: Parameters<typeof listQuery>[0]['sort']) =>
      listQuery({ keyword: '礼盒', sort, price: NO_PRICE });
    expect(q('default')).toEqual({ pageSize: 20, keyword: '礼盒' });
    expect(q('sales')).toMatchObject({ sortBy: 'sales', sortOrder: 'desc' });
    expect(q('new')).toMatchObject({ sortBy: 'createdAt', sortOrder: 'desc' });
    expect(q('price-asc')).toMatchObject({ sortBy: 'price', sortOrder: 'asc' });
    expect(q('price-desc')).toMatchObject({ sortBy: 'price', sortOrder: 'desc' });
  });

  it('flips 价格 on a second tap', () => {
    expect(nextPriceSort('default')).toBe('price-asc');
    expect(nextPriceSort('price-asc')).toBe('price-desc');
    expect(nextPriceSort('price-desc')).toBe('price-asc');
  });

  it('cleans the price range: blanks and junk dropped, backwards ends swapped', () => {
    expect(moneyOf('12.5')).toBe('12.50');
    expect(moneyOf('abc')).toBeNull();
    expect(moneyOf('1.234')).toBeNull();
    expect(normalisePrice({ from: '80', to: '20' })).toEqual({ from: '20.00', to: '80.00' });
    expect(normalisePrice({ from: 'x', to: '30' })).toEqual({ from: '', to: '30.00' });
    expect(listQuery({ sort: 'default', price: { from: '10', to: '' } })).toEqual({
      pageSize: 20,
      priceFrom: '10.00',
    });
  });
});
