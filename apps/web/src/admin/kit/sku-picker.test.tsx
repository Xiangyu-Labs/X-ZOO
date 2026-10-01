import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  catalogAdminProductDetail,
  catalogAdminProductList,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  adminProductDetailExample,
  adminProductListItemExample,
  productSkuExample,
  type AdminProductDetail,
  type AdminProductListItem,
} from '@shop/contracts/catalog/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, zhName } from '@/test/render';

import { SkuPicker, type PickedSku } from './sku-picker';

/**
 * 选择商品规格 — search, expand, tick, confirm.
 *
 * The picker is the answer to a "商品 ID" box on an activity form. What
 * matters is that it reads the catalog's own routes (so the rows are the
 * product page's rows) and that what it hands back carries the *product* id
 * alongside the SKU id — a SKU id alone is exactly the mistake the picker
 * exists to make impossible.
 */

const product: AdminProductListItem = {
  ...adminProductListItemExample,
  id: '12',
  name: '手冲挂耳咖啡',
  imageUrl: 'https://cdn.example.com/p/12.png',
  price: '49.00',
  stock: 200,
  specMode: true,
};

const detail: AdminProductDetail = {
  ...adminProductDetailExample,
  ...product,
  skus: [
    { ...productSkuExample, id: '1201', specText: '深烘 | 10 片', price: '49.00', stock: 120 },
    {
      ...productSkuExample,
      id: '1202',
      specText: '浅烘 | 10 片',
      price: '52.00',
      stock: 80,
      isDefault: false,
    },
  ],
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(catalogAdminProductDetail, detail),
    on(catalogAdminProductList, { items: [product], total: 1, page: 1, pageSize: 10 }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

describe('SkuPicker', () => {
  it('searches, expands a product and returns the ticked SKUs with their product', async () => {
    const calls = stubApi();
    const onSelect = vi.fn<(skus: PickedSku[]) => void>();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderAdmin(<SkuPicker open onClose={() => {}} onSelect={onSelect} />);

    // The search hits the catalog's admin list route with the typed keyword.
    await user.type(screen.getByPlaceholderText('搜索商品名称'), '挂耳');
    await user.click(screen.getByRole('button', { name: zhName('搜索') }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes('keyword=%E6%8C%82%E8%80%B3'))).toBe(true),
    );
    await waitFor(() => expect(screen.getByText('手冲挂耳咖啡')).toBeInTheDocument());

    // Expanding reads the product detail — the same SKU rows the product page
    // shows, not a second definition of "a sellable SKU".
    await user.click(screen.getByRole('button', { name: /Expand row|展开行/ }));
    await waitFor(() => expect(screen.getByText('深烘 | 10 片')).toBeInTheDocument());
    expect(calls.some((call) => call.url.includes('/admin-api/catalog/products/12'))).toBe(true);

    // 确定 is dead until something is ticked.
    expect(screen.getByRole('button', { name: zhName('确定') })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /深烘/ }));
    await user.click(screen.getByRole('checkbox', { name: /浅烘/ }));
    expect(screen.getByText('已选 2 条')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: zhName('确定') }));

    expect(onSelect).toHaveBeenCalledWith([
      { productId: '12', skuId: '1201', specText: '深烘 | 10 片', price: '49.00', stock: 120 },
      { productId: '12', skuId: '1202', specText: '浅烘 | 10 片', price: '52.00', stock: 80 },
    ]);
  });

  it('un-ticks a second click and keeps one row when `multiple` is off', async () => {
    stubApi();
    const onSelect = vi.fn<(skus: PickedSku[]) => void>();
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderAdmin(
      <SkuPicker open multiple={false} productId="12" onClose={() => {}} onSelect={onSelect} />,
    );

    // With a `productId` the search box is gone: a group buy on product 12
    // cannot price a SKU of product 13, so the picker does not offer one.
    await waitFor(() => expect(screen.getByText('只能选择当前商品的规格')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('搜索商品名称')).not.toBeInTheDocument();

    // A `productId` also opens the row: there is nothing else to choose.
    await waitFor(() => expect(screen.getByText('深烘 | 10 片')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: /深烘/ }));
    await user.click(screen.getByRole('checkbox', { name: /浅烘/ }));
    expect(screen.getByText('已选 1 条')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: zhName('确定') }));
    expect(onSelect).toHaveBeenCalledWith([
      { productId: '12', skuId: '1202', specText: '浅烘 | 10 片', price: '52.00', stock: 80 },
    ]);
  });

  it('pre-ticks what the caller already chose', async () => {
    stubApi();
    const chosen: PickedSku[] = [
      { productId: '12', skuId: '1202', specText: '浅烘 | 10 片', price: '52.00', stock: 80 },
    ];
    renderAdmin(
      <SkuPicker open productId="12" value={chosen} onClose={() => {}} onSelect={() => {}} />,
    );

    await waitFor(() => expect(screen.getByText('已选 1 条')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /浅烘/ })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: /深烘/ })).not.toBeChecked();
  });
});
