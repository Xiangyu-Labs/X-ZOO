import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import {
  catalogAdminProductDetail,
  catalogAdminProductList,
  catalogAdminProductUpdate,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  adminProductListItemExample,
  type AdminProductDetail,
} from '@shop/contracts/catalog/schemas';
import {
  catalogAdminLabelList,
  catalogAdminParamTemplateList,
  catalogAdminProtectionList,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import { shippingTemplateOptionList } from '@shop/contracts/shipping/shipping.template.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { withStubAssets } from '@/test/asset-source';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { ProductEditorPage, formValuesOf } from './product-editor';

const detail: AdminProductDetail = {
  id: '1',
  name: '简约白 T 恤',
  subtitle: null,
  spu: null,
  kind: 'physical',
  status: 'on_shelf',
  imageUrl: 'https://cdn.example.com/t.png',
  price: '39.00',
  originalPrice: null,
  cost: null,
  stock: 10,
  sales: 3,
  displaySalesBoost: 0,
  views: 12,
  specMode: true,
  isHot: false,
  isNew: false,
  isBest: false,
  isBenefit: false,
  isRecommended: false,
  sortOrder: 0,
  categoryIds: ['17'],
  categoryNames: ['男装'],
  labels: [],
  createdAt: '2026-06-01T10:00:00+08:00',
  updatedAt: '2026-06-01T10:00:00+08:00',
  deletedAt: null,
  keyword: null,
  barCode: null,
  cardImageUrl: null,
  sliderImages: [],
  videoUrl: null,
  unitName: '件',
  freightMode: 'template',
  fixedFreight: null,
  shippingTemplateId: '3',
  purchaseLimitMode: 'none',
  purchaseLimitQuantity: null,
  minPurchaseQuantity: 1,
  customForm: [{ key: 'engraving', label: '刻字内容', type: 'text', required: false }],
  descriptionHtml: '<p>纯棉</p>',
  specs: [
    {
      id: '900',
      name: '尺码',
      sortOrder: 0,
      values: [
        { id: '9001', value: 'M', imageUrl: null, sortOrder: 0 },
        { id: '9002', value: 'XL', imageUrl: null, sortOrder: 1 },
      ],
    },
  ],
  skus: [
    {
      id: '1100',
      skuCode: 'TS-001-M',
      specText: 'M',
      specValues: { 尺码: 'M' },
      imageUrl: null,
      price: '39.00',
      originalPrice: null,
      cost: null,
      stock: 6,
      sales: 2,
      barCode: null,
      weight: null,
      volume: null,
      isDefault: true,
      isVisible: true,
      sortOrder: 0,
    },
    {
      id: '1101',
      skuCode: 'TS-001-XL',
      specText: 'XL',
      specValues: { 尺码: 'XL' },
      imageUrl: null,
      price: '42.00',
      originalPrice: null,
      cost: null,
      stock: 4,
      sales: 1,
      barCode: null,
      weight: null,
      volume: null,
      isDefault: false,
      isVisible: true,
      sortOrder: 1,
    },
  ],
  params: [{ id: '70', name: '材质', value: '纯棉', templateId: '5' }],
  protectionIds: [],
  labelIds: [],
  recommendedProductIds: [],
  giftCouponIds: [],
};

const neighbours = [
  { ...adminProductListItemExample, id: '12', name: '挂耳咖啡' },
  { ...adminProductListItemExample, id: '13', name: '明前龙井' },
];

const neighbourList = on(catalogAdminProductList, (call) => {
  const ids = call.query.get('ids')?.split(',');
  const keyword = call.query.get('keyword');
  const items = neighbours.filter(
    (item) =>
      (ids === undefined || ids.includes(item.id)) &&
      (keyword === null || item.name.includes(keyword)),
  );
  return { items, total: items.length, page: 1, pageSize: 20 };
});

function stubApi(): StubCall[] {
  const empty = { items: [], total: 0, page: 1, pageSize: 100 };
  return stubRoutes([
    on(catalogAdminCategoryTree, { items: [] }),
    on(shippingTemplateOptionList, {
      items: [
        { id: '3', name: '江浙沪包邮', chargeMode: 'quantity' },
        { id: '4', name: '大件走重量', chargeMode: 'weight' },
      ],
    }),
    on(catalogAdminLabelList, empty),
    on(catalogAdminProtectionList, empty),
    on(catalogAdminParamTemplateList, empty),
    on(catalogAdminProductDetail, detail),
    on(catalogAdminProductUpdate, detail),
    neighbourList,
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const editor = { ...testIdentity, permissions: ['catalog:product:read', 'catalog:product:write'] };

describe('商品编辑器', () => {
  it('turns the detail response into form input without a single null', () => {
    const values = formValuesOf(detail);

    // `exactOptionalPropertyTypes`: an optional field is absent or real.
    expect('subtitle' in values).toBe(false);
    expect('fixedFreight' in values).toBe(false);
    expect('purchaseLimitQuantity' in values).toBe(false);
    expect(values.shippingTemplateId).toBe('3');

    // `specValues` is the SKU's identity — the server matches an incoming row
    // to an existing SKU by it, which is how editing a price leaves the stock
    // and the sales counter alone.
    expect(values.skus?.[1]).toMatchObject({
      specValues: { 尺码: 'XL' },
      skuCode: 'TS-001-XL',
      price: '42.00',
      stock: 4,
    });
    expect(values.skus?.[1]).not.toHaveProperty('sales');
    expect(values.params?.[0]).toEqual({
      name: '材质',
      value: '纯棉',
      templateId: '5',
      sortOrder: 0,
    });
  });

  it('loads a product into the form and saves it back through PUT', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), { identity: editor });

    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    // The matrix renders one row per existing combination. It fills a render
    // after the basic fields, so it is waited for in its own right.
    await waitFor(() => {
      expect(screen.getByLabelText('库存 1')).toHaveValue('6');
      expect(screen.getByLabelText('库存 2')).toHaveValue('4');
    });

    await userEvent.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect(save?.url).toContain('/admin-api/catalog/products/1');
      const body = save?.body as Record<string, unknown>;
      expect(body.name).toBe('简约白 T 恤');
      expect(body.skus).toHaveLength(2);
      // No editor for the checkout form yet, so it is carried across rather
      // than silently dropped on the next save.
      expect(body.customForm).toEqual(detail.customForm);
      // A template product must not also carry a fixed freight.
      expect(body.fixedFreight).toBeUndefined();
      // The select round-trips the id it was loaded with.
      expect(body.shippingTemplateId).toBe('3');
    });
  });

  it('picks 推荐商品 by name and saves their ids', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), { identity: editor });
    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));

    await userEvent.type(screen.getByLabelText('推荐商品'), '龙井');
    await userEvent.click(await screen.findByTitle('明前龙井（#13）'));
    await userEvent.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect((save?.body as Record<string, unknown>).recommendedProductIds).toEqual(['13']);
    });
  });

  it('says when there is unsaved work, saves on Ctrl+S, and is clean again after', async () => {
    const calls = stubApi();
    const user = userEvent.setup();
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), { identity: editor });
    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    expect(screen.getByText('没有未保存的修改')).toBeInTheDocument();

    await user.type(screen.getByLabelText('商品名称'), '（新款）');
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();

    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect((save?.body as Record<string, unknown> | undefined)?.name).toBe('简约白 T 恤（新款）');
    });
    expect(await screen.findByText('没有未保存的修改')).toBeInTheDocument();
  });

  it('opens on a fresh read, not a detail cached before a 下架 in the list', async () => {
    let current: AdminProductDetail = detail;
    const calls = stubRoutes([
      on(catalogAdminCategoryTree, { items: [] }),
      on(shippingTemplateOptionList, { items: [] }),
      on(catalogAdminLabelList, { items: [], total: 0, page: 1, pageSize: 100 }),
      on(catalogAdminProtectionList, { items: [], total: 0, page: 1, pageSize: 100 }),
      on(catalogAdminParamTemplateList, { items: [], total: 0, page: 1, pageSize: 100 }),
      neighbourList,
      on(catalogAdminProductDetail, () => current),
      on(catalogAdminProductUpdate, () => current),
    ]);
    // The admin's own cache settings: a detail read seconds ago counts as fresh.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } },
    });

    const first = renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), {
      identity: editor,
      queryClient,
    });
    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    first.unmount();

    // Taken off the shelf from the list meanwhile.
    current = { ...detail, status: 'off_shelf' };
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), {
      identity: editor,
      queryClient,
    });
    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    await userEvent.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect((save?.body as Record<string, unknown>).status).toBe('off_shelf');
    });
  });

  it('saves a 卡密 product showing its pool, and keeps saved SKU codes read-only', async () => {
    const card: AdminProductDetail = {
      ...detail,
      kind: 'virtual_card',
      freightMode: 'free',
      shippingTemplateId: null,
      specMode: false,
      specs: [],
      skus: [{ ...detail.skus[0]!, specValues: {}, specText: '', stock: 3 }],
    };
    const calls = stubRoutes([
      on(catalogAdminCategoryTree, { items: [] }),
      on(shippingTemplateOptionList, { items: [] }),
      on(catalogAdminLabelList, { items: [], total: 0, page: 1, pageSize: 100 }),
      on(catalogAdminProtectionList, { items: [], total: 0, page: 1, pageSize: 100 }),
      on(catalogAdminParamTemplateList, { items: [], total: 0, page: 1, pageSize: 100 }),
      neighbourList,
      on(catalogAdminProductDetail, card),
      on(catalogAdminProductUpdate, card),
    ]);
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), { identity: editor });

    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    await waitFor(() => expect(screen.getByLabelText('规格编码')).toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect((save?.body as { skus: unknown[] }).skus[0]).toMatchObject({
        stock: 3,
        expectedStock: 3,
      });
    });
  });

  it('shows a look-only role the product without a 保存 to press into a 403', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), {
      identity: { ...testIdentity, permissions: ['catalog:product:read'] },
    });

    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    expect(screen.getByLabelText('商品名称')).toBeDisabled();
    expect(screen.queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();
    expect(screen.getByText('你的身份只能查看商品，不能在这里修改')).toBeInTheDocument();
    // Nor does it ask for the option lists it holds no atom for.
    expect(calls.some((call) => call.url.includes('/admin-api/catalog/labels'))).toBe(false);
    // The server blanks 成本价 for this role: no column, rather than empty boxes.
    expect(screen.queryByText('成本价')).not.toBeInTheDocument();
  });

  it('shows 成本价 to a look-only role that may export, which the server does tell it', async () => {
    stubApi();
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), {
      identity: {
        ...testIdentity,
        permissions: ['catalog:product:read', 'catalog:product:export'],
      },
    });

    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));
    expect(screen.getAllByText('成本价').length).toBeGreaterThan(0);
  });

  /**
   * 运费模板 is a select over the shipping options route, not a typed id. The
   * 计费方式 is part of the label because two templates can
   * share a name and charge differently, and picking the wrong one is a
   * freight bug nobody notices until a customer complains.
   */
  it('offers the shipping templates as a select, and only in 运费模板 mode', async () => {
    stubApi();
    renderAdmin(withStubAssets(<ProductEditorPage productId="1" />), { identity: editor });

    await waitFor(() => expect(screen.getByLabelText('商品名称')).toHaveValue('简约白 T 恤'));

    // Loaded as 运费模板, so the select is there, showing the template's name.
    // `getByRole` and not `getByLabelText`: the 运费 radio group has an option
    // labelled 运费模板 too.
    const select = screen.getByRole('combobox', { name: '运费模板' });
    await waitFor(() => expect(screen.getByTitle('江浙沪包邮（按件数）')).toBeInTheDocument());

    await userEvent.click(select);
    await waitFor(() => expect(screen.getByTitle('大件走重量（按重量）')).toBeInTheDocument());
    await userEvent.click(screen.getByTitle('大件走重量（按重量）'));

    // 固定运费 hides the template select and says the charge is per unit —
    // checkout multiplies `postage` by the quantity.
    // antd's radio button puts `pointer-events: none` on the input itself.
    await userEvent
      .setup({ pointerEventsCheck: 0 })
      .click(screen.getByRole('radio', { name: '固定运费' }));
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: '运费模板' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('按件收取：下单数量 × 该金额')).toBeInTheDocument();
  });
});
