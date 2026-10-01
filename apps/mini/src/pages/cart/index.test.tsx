import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { routeQueryKey } from '@shop/api-client/react';
import { useAppConfigStore } from '@/app-config';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { startSession, useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { cartItemFixture, cartListFixture } from '@/test/cart-fixture';
import {
  cardFixture,
  pageOf,
  productDetailFixture,
  skuMatrixFixture,
} from '@/test/catalog-fixture';
import { holdRequests, serveApi, type FakeReply } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import Cart from './index';

type Routes = Record<string, (body: unknown) => FakeReply>;
type Item = ReturnType<typeof cartItemFixture>;

const count = (items: Item[]) => ({
  items: items.length,
  quantity: items.reduce((sum, item) => sum + item.quantity, 0),
  availableCount: items.filter((item) => item.available).length,
  unavailableCount: items.filter((item) => !item.available).length,
});

/** A small in-memory cart behind the fake API, so a mutation's refetch sees its effect. */
function serveCart(start: Item[], overrides: Routes = {}) {
  let items = start;
  const mutated = (item: Item | null) => ({ body: { item, cart: count(items) } });
  const seen = serveApi({
    'GET /api/v1/cart': () => ({ body: cartListFixture(items) }),
    'GET /api/v1/cart/count': () => ({ body: count(items) }),
    'GET /api/v1/catalog/products': () => ({
      body: pageOf([cardFixture({ id: '31', name: '温感按摩油' })]),
    }),
    'POST /api/v1/user-coupons/applicable': () => ({ body: { items: [], subtotal: '0.00' } }),
    'POST /api/v1/cart/selections': (body) => {
      const { itemIds, all, isSelected } = body as {
        itemIds: string[];
        all: boolean;
        isSelected: boolean;
      };
      items = items.map((item) =>
        item.available && (all || itemIds.includes(item.id)) ? { ...item, isSelected } : item,
      );
      return { body: cartListFixture(items) };
    },
    'PUT /api/v1/cart/items/501': (body) => {
      const { quantity, skuId } = body as { quantity?: number; skuId?: string };
      items = items.map((item) =>
        item.id === '501'
          ? {
              ...item,
              ...(quantity ? { quantity, subtotal: (59 * quantity).toFixed(2) } : {}),
              ...(skuId ? { skuId } : {}),
            }
          : item,
      );
      return mutated(items.find((item) => item.id === '501') ?? null);
    },
    'POST /api/v1/cart/items/removals': (body) => {
      const { itemIds, unavailableOnly } = body as { itemIds: string[]; unavailableOnly: boolean };
      const before = items.length;
      items = items.filter((item) =>
        unavailableOnly ? item.available : !itemIds.includes(item.id),
      );
      return { body: { removed: before - items.length, cart: count(items) } };
    },
    ...overrides,
  });
  return { seen, items: () => items };
}

const rows = () => [
  cartItemFixture(),
  cartItemFixture({
    id: '502',
    productId: '31',
    skuId: '301',
    productName: '温感按摩油',
    specText: '',
    quantity: 1,
    unitPrice: '39.00',
    subtotal: '39.00',
    isSelected: false,
  }),
  cartItemFixture({
    id: '503',
    productId: '40',
    skuId: '401',
    productName: '旧款香氛蜡烛',
    available: false,
    state: 'off_shelf',
  }),
];

async function signIn() {
  taroFake.storage.set('shop.session.token', 't1');
  await startSession();
}

describe('购物车', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
    useCheckoutDraft.setState({ draft: null });
  });

  it('asks a guest to log in, and still recommends', async () => {
    const { seen } = serveCart([]);
    await renderPage(<Cart />);

    expect(screen.getByText('登录后查看购物车')).toBeTruthy();
    expect(await screen.findByText('温感按摩油')).toBeTruthy();
    expect(seen.some((request) => request.key === 'GET /api/v1/cart')).toBe(false);
  });

  it('shows the rows, the greyed ones with their reason, and the ticked total', async () => {
    serveCart(rows());
    await signIn();
    await renderPage(<Cart />);

    const available = await waitFor(() => {
      const found = document.getElementById('cart-available');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(available).getByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(within(available).getByText('黑 / M')).toBeTruthy();
    const off = document.getElementById('cart-unavailable') as HTMLElement;
    expect(within(off).getByText('失效商品 1')).toBeTruthy();
    expect(within(off).getByText('商品已下架')).toBeTruthy();
    expect(screen.getByRole('button', { name: '结算(2)' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '全选' }).getAttribute('aria-checked')).not.toBe(
      'true',
    );
  });

  it('ticks rows on the server and sets quantities outright', async () => {
    const { seen } = serveCart(rows());
    await signIn();
    await renderPage(<Cart />);

    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 温感按摩油' }));
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/cart/selections')?.body).toEqual({
        itemIds: ['502'],
        all: false,
        isSelected: true,
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '结算(3)' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '增加柔雾丝绒礼盒的数量' }));
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'PUT /api/v1/cart/items/501')?.body).toEqual({
        quantity: 3,
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '结算(4)' })).toBeTruthy());
  });

  it('sends one quantity per row at a time, then the last one tapped', async () => {
    const { seen } = serveCart(rows());
    await signIn();
    await renderPage(<Cart />);
    const plus = await screen.findByRole('button', { name: '增加柔雾丝绒礼盒的数量' });
    const held = holdRequests('/cart/items/501');

    // 2 → 3 → 4 → 5 before the first answer: two PUTs racing could land 4 after 5.
    fireEvent.click(plus);
    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(screen.getByRole('button', { name: '柔雾丝绒礼盒的数量 5，点按输入' })).toBeTruthy();
    await waitFor(() => {
      held.release();
      expect(screen.getByRole('button', { name: '结算(5)' })).toBeTruthy();
    });

    expect(seen.filter((r) => r.key === 'PUT /api/v1/cart/items/501').map((r) => r.body)).toEqual([
      { quantity: 3 },
      { quantity: 5 },
    ]);
  });

  it('checks out the ticked rows through the in-memory draft', async () => {
    serveCart(rows());
    await signIn();
    await renderPage(<Cart />);

    fireEvent.click(await screen.findByRole('button', { name: '结算(2)' }));
    expect(useCheckoutDraft.getState().draft).toMatchObject({
      source: 'cart',
      cartItemIds: ['501'],
      kind: 'normal',
    });
    // Names by SKU, so 确认订单 can say which item a refusal is about.
    expect(Object.keys(useCheckoutDraft.getState().draft?.names ?? {})).toHaveLength(1);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/order/checkout/index' },
      }),
    );
  });

  it('clears the greyed rows, and deletes the ticked ones in 管理', async () => {
    const cart = serveCart(rows());
    await signIn();
    await renderPage(<Cart />);

    fireEvent.click(await screen.findByRole('button', { name: '清空失效商品' }));
    await waitFor(() =>
      expect(cart.seen.find((r) => r.key === 'POST /api/v1/cart/items/removals')?.body).toEqual({
        itemIds: [],
        unavailableOnly: true,
      }),
    );
    await waitFor(() => expect(document.getElementById('cart-unavailable')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(cart.items().map((item) => item.id)).toEqual(['502']));
  });

  it('moves the ticked rows to 收藏, and a cached 商品详情 of them says so next time', async () => {
    const cart = serveCart(rows(), {
      'POST /api/v1/me/favorites/batch': () => ({
        status: 201,
        body: { added: 1, items: [{ productId: '12', favorited: true }] },
      }),
    });
    await signIn();
    const { client } = await renderPage(<Cart />);
    const product = routeQueryKey('catalog.productDetail', { params: { id: '12' } });
    client.setQueryData(product, productDetailFixture());

    fireEvent.click(await screen.findByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('button', { name: '移入收藏' }));
    await waitFor(() => expect(cart.items().map((item) => item.id)).toEqual(['502', '503']));
    expect(cart.seen.find((r) => r.key === 'POST /api/v1/me/favorites/batch')?.body).toEqual({
      productIds: ['12'],
    });
    expect(client.getQueryState(product)?.isInvalidated).toBe(true);
  });

  it('changes a row’s spec in the SkuSheet', async () => {
    const { seen } = serveCart(rows(), {
      'GET /api/v1/catalog/products/12/skus': () => ({ body: skuMatrixFixture }),
    });
    await signIn();
    await renderPage(<Cart />);

    fireEvent.click(await screen.findByRole('button', { name: '规格 黑 / M，修改规格' }));
    const sheet = await waitFor(() => {
      const found = document.getElementById('sku-sheet');
      expect(found).not.toBeNull();
      expect(within(found as HTMLElement).queryByRole('radio', { name: '白' })).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(sheet).getByRole('radio', { name: '白' }));
    fireEvent.click(screen.getAllByRole('button', { name: '确定' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'PUT /api/v1/cart/items/501')?.body).toEqual({
        skuId: '101',
        quantity: 2,
      }),
    );
  });

  it('shows the coupon hint for the ticked rows', async () => {
    serveCart(rows(), {
      'POST /api/v1/user-coupons/applicable': () => ({
        body: {
          subtotal: '118.00',
          items: [
            {
              coupon: {
                id: '801',
                templateId: '81',
                title: '店铺券',
                discountAmount: '20.00',
                minSpend: '150.00',
                scope: 'all_products',
                status: 'unused',
                sourceKind: 'claim',
                validFrom: '2026-09-01T00:00:00+08:00',
                validTo: '2026-12-31T23:59:59+08:00',
                usedAt: null,
                createdAt: '2026-09-01T00:00:00+08:00',
              },
              usable: false,
              discount: '0.00',
              eligibleLineIndexes: [0],
              reason: 'COUPON_MIN_SPEND_NOT_MET',
            },
          ],
        },
      }),
    });
    await signIn();
    await renderPage(<Cart />);

    expect(await screen.findByText('再买 ¥32.00 可用「满150减20」')).toBeTruthy();
  });

  it('says an empty cart is empty', async () => {
    serveCart([]);
    await signIn();
    await renderPage(<Cart />);
    expect(await screen.findByText('购物车还是空的')).toBeTruthy();
    expect(document.getElementById('cart-bar')).toBeNull();
  });
});
