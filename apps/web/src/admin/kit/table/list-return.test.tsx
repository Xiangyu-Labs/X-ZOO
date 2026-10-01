import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listReturnHref, useDetailHref, useListReturn, withListReturn } from './list-return';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => search,
}));

afterEach(() => {
  search = new URLSearchParams();
});

describe('返回列表 keeps the list the operator left', () => {
  it('a list hands its tab, filters and page to the detail it opens', () => {
    search = new URLSearchParams('tab=off_shelf&keyword=T恤&page=3');
    const { result } = renderHook(() => useDetailHref());
    const href = result.current('/admin/catalog/products/7');
    expect(href.startsWith('/admin/catalog/products/7?list=')).toBe(true);

    search = new URLSearchParams(href.split('?')[1]);
    const back = renderHook(() => useListReturn('/admin/catalog/products')).result.current;
    expect(back.listHref).toBe('/admin/catalog/products?tab=off_shelf&keyword=T%E6%81%A4&page=3');
    // 编辑商品 → 卡密库存 → 返回列表 still lands on page 3.
    expect(back.keepList('/admin/catalog/products/7/cards')).toBe(
      `/admin/catalog/products/7/cards?list=${encodeURIComponent(search.get('list')!)}`,
    );
  });

  it('an unfiltered list and a missing ?list= mean the plain list', () => {
    expect(withListReturn('/admin/decor/3', '')).toBe('/admin/decor/3');
    expect(listReturnHref('/admin/decor', null)).toBe('/admin/decor');
    const { result } = renderHook(() => useListReturn('/admin/decor'));
    expect(result.current.listHref).toBe('/admin/decor');
    expect(result.current.keepList('/admin/decor/3')).toBe('/admin/decor/3');
  });

  it('?list= only ever supplies a query string, never where to go', () => {
    expect(listReturnHref('/admin/decor', 'https://evil.example/x?a=1')).toBe(
      '/admin/decor?https%3A%2F%2Fevil.example%2Fx%3Fa=1',
    );
    expect(listReturnHref('/admin/decor', '//evil.example')).toMatch(/^\/admin\/decor\?/);
  });
});
