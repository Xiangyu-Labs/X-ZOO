import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore } from '@/app-config';
import { useCheckoutDraft, type CheckoutDraft } from '@/features/checkout/draft';
import { setSubscribeTemplates } from '@/platform';
import { startSession, useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import {
  applicableFixture,
  orderFixture,
  previewFixture,
  previewWithCoupon,
} from '@/test/checkout-fixture';
import { handBackNewAddress } from '@/packages/account/shared/address';
import { addressFixture, cityTreeFixture } from '@/test/address-fixture';
import { serveApi, type FakeReply } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { routeQueryKey } from '@shop/api-client/react';
import { taroFake } from '@/test/taro-fake/taro';
import CheckoutPage from './index';

type Routes = Record<string, (body: unknown) => FakeReply>;

const buyNow: CheckoutDraft = {
  source: 'buy-now',
  item: { skuId: '103', quantity: 2 },
  kind: 'normal',
};

function serve(overrides: Routes = {}) {
  return serveApi({
    'POST /api/v1/checkout/preview': (body) => ({
      body:
        (body as { userCouponId?: string | null }).userCouponId === '901'
          ? previewWithCoupon()
          : previewFixture(),
    }),
    'POST /api/v1/user-coupons/applicable': () => ({ body: applicableFixture() }),
    'POST /api/v1/orders': () => ({ status: 201, body: orderFixture() }),
    ...overrides,
  });
}

async function open(draft: CheckoutDraft = buyNow) {
  useCheckoutDraft.setState({ draft });
  taroFake.storage.set('shop.session.token', 't1');
  await startSession();
  return renderPage(<CheckoutPage />);
}

const submitButton = () => screen.getByRole('button', { name: '提交订单' });
/** Priced and settled: the coupon list is in and the button no longer waits. */
const ready = () =>
  waitFor(() => expect(submitButton().getAttribute('aria-disabled')).not.toBe('true'));

describe('确认订单', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });
  afterEach(() => setSubscribeTemplates({}));

  it('says so when there is nothing to check out', async () => {
    useCheckoutDraft.setState({ draft: null });
    await renderPage(<CheckoutPage />);
    expect(screen.getByText('没有待结算的商品')).toBeTruthy();
  });

  it('applies the best coupon, asks for subscriptions in the tap, and creates the order', async () => {
    setSubscribeTemplates({ checkout: ['tpl-paid', 'tpl-shipped'] });
    let askedFirst = false;
    const seen = serve({
      'POST /api/v1/orders': () => {
        // The prompt went out in the tap, before the order request (C08).
        askedFirst = taroFake.calls.some((call) => call.api === 'requestSubscribeMessage');
        return { status: 201, body: orderFixture() };
      },
    });
    const { client } = await open();
    const wallet = routeQueryKey('coupon.myList', { query: { state: 'unused' } });
    client.setQueryData(wallet, { items: [], page: 1, pageSize: 20, total: 0 });
    const claimable = routeQueryKey('coupon.claimableList', { query: {} });
    client.setQueryData(claimable, { items: [], page: 1, pageSize: 20, total: 0 });
    const home = routeQueryKey('decor.pageHome');
    client.setQueryData(home, {});

    expect(await screen.findByText('-¥10.00')).toBeTruthy();
    await ready();
    expect(screen.getByText('林小姐')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('订单备注'), { target: { value: '工作日送达' } });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/order/cashier/index?orderId=9' },
      }),
    );
    expect(taroFake.calls).toContainEqual({
      api: 'requestSubscribeMessage',
      args: expect.objectContaining({ tmplIds: ['tpl-paid', 'tpl-shipped'] }),
    });
    expect(askedFirst).toBe(true);
    const created = seen.find((r) => r.key === 'POST /api/v1/orders')?.body as Record<
      string,
      unknown
    >;
    expect(created).toMatchObject({
      source: 'buy-now',
      item: { skuId: '103', quantity: 2 },
      kind: 'normal',
      addressId: '301',
      userCouponId: '901',
      expectedPayableAmount: '116.00',
      buyerRemark: '工作日送达',
    });
    expect(String(created.idempotencyKey)).toMatch(/^mini-/);
    expect(useCheckoutDraft.getState().draft).toBeNull();
    // The coupon went onto the order: 我的优惠券 must not offer it, nor the coupon lists.
    expect(client.getQueryState(wallet)?.isInvalidated).toBe(true);
    expect(client.getQueryState(claimable)?.isInvalidated).toBe(true);
    // Nor 首页's coupon blocks; its 订单入口 counts one more 待付款.
    expect(client.getQueryState(home)?.isInvalidated).toBe(true);
  });

  it('AGENTS 17 — a double tap on 提交订单 sends one order', async () => {
    const seen = serve();
    await open();
    await ready();
    const submit = submitButton();
    // Both taps before React re-renders, as on a phone: only the button's own lock stops the second.
    act(() => {
      submit.click();
      submit.click();
    });
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/order/cashier/index?orderId=9' },
      }),
    );
    expect(seen.filter((r) => r.key === 'POST /api/v1/orders')).toHaveLength(1);
  });

  it('lets the shopper drop the coupon', async () => {
    const seen = serve();
    await open();

    fireEvent.click(await screen.findByRole('link', { name: '优惠券，-¥10.00' }));
    const sheet = document.getElementById('coupon-sheet') as HTMLElement;
    expect(within(sheet).getByText('未达到使用门槛')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('radio', { name: '不使用优惠券' }));

    expect(await screen.findByText('不使用')).toBeTruthy();
    await ready();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/orders')?.body).toMatchObject({
        userCouponId: null,
        expectedPayableAmount: '126.00',
      }),
    );
  });

  it('asks for an address before submitting, and imports WeChat’s', async () => {
    taroFake.address = {
      userName: '林小姐',
      telNumber: '13800138000',
      provinceName: '广东省',
      cityName: '深圳市',
      countyName: '南山区',
      detailInfo: '科技园 100 号',
      postalCode: '518057',
    };
    let created = false;
    const seen = serve({
      'POST /api/v1/checkout/preview': (body) => ({
        // No address until the imported one (302) is chosen; then the preview is to it.
        body: previewFixture({
          receiver:
            (body as { addressId?: string }).addressId === '302'
              ? {
                  addressId: '302',
                  name: '林小姐',
                  phone: '13800138000',
                  province: '广东省',
                  city: '深圳市',
                  district: '南山区',
                  detail: '科技园 100 号',
                  postCode: '518057',
                }
              : null,
        }),
      }),
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
      'GET /api/v1/addresses': () => ({ body: { items: [], total: 0, page: 1, pageSize: 50 } }),
      'POST /api/v1/addresses': () => {
        created = true;
        return {
          status: 201,
          body: {
            id: '302',
            receiverName: '林小姐',
            receiverPhone: '13800138000',
            provinceId: '44',
            cityId: '4403',
            districtId: '440305',
            provinceName: '广东省',
            cityName: '深圳市',
            districtName: '南山区',
            detail: '科技园 100 号',
            postCode: '518057',
            lng: null,
            lat: null,
            isDefault: true,
            createdAt: '2026-09-23T10:00:00+08:00',
            updatedAt: '2026-09-23T10:00:00+08:00',
          },
        };
      },
    });
    const { client } = await open();
    // 地址管理's edit form for another address, which now is not the default.
    const other = routeQueryKey('user.addressDetail', { params: { id: '301' } });
    client.setQueryData(other, {});

    await ready();
    fireEvent.click(submitButton());
    expect(seen.some((r) => r.key === 'POST /api/v1/orders')).toBe(false);

    // Submitting without an address opened the address sheet: import from its footer.
    await waitFor(() => expect(document.getElementById('address-sheet')).not.toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: '导入微信地址' }).at(-1) as HTMLElement);
    await waitFor(() => expect(created).toBe(true));
    await waitFor(() => expect(client.getQueryState(other)?.isInvalidated).toBe(true));
    // With the division ids, which freight is priced on.
    expect(seen.find((r) => r.key === 'POST /api/v1/addresses')?.body).toMatchObject({
      receiverName: '林小姐',
      provinceId: '44',
      provinceName: '广东省',
      cityId: '4403',
      districtId: '440305',
      postCode: '518057',
    });
    await waitFor(() =>
      expect(
        seen.some(
          (r) =>
            r.key === 'POST /api/v1/checkout/preview' &&
            (r.body as { addressId?: string }).addressId === '302',
        ),
      ).toBe(true),
    );
  });

  it('finishes an imported address in the form when the city tree does not resolve it', async () => {
    taroFake.address = {
      userName: '林小姐',
      telNumber: '13800138000',
      provinceName: '海外',
      cityName: '某市',
      countyName: '',
      detailInfo: '某街 1 号',
      postalCode: '',
    };
    const seen = serve({
      'POST /api/v1/checkout/preview': () => ({
        body: previewFixture({ receiver: null } as never),
      }),
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
      'GET /api/v1/addresses': () => ({ body: { items: [], total: 0, page: 1, pageSize: 50 } }),
    });
    await open();
    await ready();
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.getElementById('address-sheet')).not.toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: '导入微信地址' }).at(-1) as HTMLElement);

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual(
        expect.objectContaining({
          api: 'navigateTo',
          args: { url: '/packages/account/address-edit/index' },
        }),
      ),
    );
    expect(
      JSON.parse((taroFake.storage.get('shop.address.imported') as string | undefined) ?? 'null'),
    ).toMatchObject({
      receiverName: '林小姐',
      region: null,
      detail: '某街 1 号',
    });
    expect(seen.some((r) => r.key === 'POST /api/v1/addresses')).toBe(false);
  });

  it('picks the address the shopper just added from the sheet, not the default', async () => {
    const seen = serve({
      // The sheet's 导入微信地址 reads the city tree.
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
      'GET /api/v1/addresses': () => ({
        body: {
          items: [{ ...addressFixture, id: '301', isDefault: true, receiverName: '林小姐' }],
          page: 1,
          pageSize: 50,
          total: 1,
        },
      }),
    });
    await open();
    await ready();
    fireEvent.click(screen.getByRole('link', { name: /收货地址：林小姐/ }));
    await waitFor(() => expect(document.getElementById('address-sheet')).not.toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: '新增收货地址' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual(
        expect.objectContaining({
          api: 'navigateTo',
          args: { url: '/packages/account/address-edit/index' },
        }),
      ),
    );

    // Saved on the address form, then back here.
    handBackNewAddress('305');
    act(() => taroFake.showPage());
    await waitFor(() =>
      expect(
        seen.some(
          (r) =>
            r.key === 'POST /api/v1/checkout/preview' &&
            (r.body as { addressId?: string }).addressId === '305',
        ),
      ).toBe(true),
    );
  });

  it('checks the custom form, and shows the presale ship time', async () => {
    const seen = serve({
      'POST /api/v1/checkout/preview': () => ({
        body: previewFixture({
          customFormFields: [{ key: 'words', label: '刻字内容', type: 'text', required: true }],
          shipAfterDays: 7,
        }),
      }),
      'POST /api/v1/user-coupons/applicable': () => ({ body: { subtotal: '118.00', items: [] } }),
    });
    await open({ ...buyNow, kind: 'presale', kindMeta: { activityId: '5' } });

    expect(await screen.findByText('预售商品：付款后 7 天内发货')).toBeTruthy();
    // The preview carries the ship time: the presale activity is not read.
    expect(seen.some((r) => r.key.startsWith('GET /api/v1/presale/'))).toBe(false);
    await ready();
    fireEvent.click(submitButton());
    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '请填写「刻字内容」' }),
    });

    fireEvent.change(screen.getByLabelText('刻字内容'), { target: { value: '安' } });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/orders')?.body).toMatchObject({
        kind: 'presale',
        kindMeta: { activityId: '5' },
        customForm: { words: '安' },
      }),
    );
  });

  it('re-prices when the price changed under the shopper', async () => {
    let previews = 0;
    serve({
      'POST /api/v1/checkout/preview': () => {
        previews += 1;
        return { body: previewFixture() };
      },
      'POST /api/v1/user-coupons/applicable': () => ({ body: { subtotal: '118.00', items: [] } }),
      'POST /api/v1/orders': () => ({
        status: 409,
        body: { code: 'ORDER_PRICE_CHANGED', message: '价格已变动' },
      }),
    });
    await open();

    await ready();
    const before = previews;
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '商品价格有变动，请确认后重新提交' }),
      }),
    );
    await waitFor(() => expect(previews).toBeGreaterThan(before));
  });
});

describe('确认订单 — when the server says no', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });

  it('keeps an undeliverable address on the page, marked, and lets the shopper change it', async () => {
    serve({
      'POST /api/v1/checkout/preview': (body) =>
        (body as { addressId?: string }).addressId === '302'
          ? { body: previewFixture() }
          : {
              status: 409,
              body: { code: 'SHIPPING_NOT_DELIVERABLE', message: '部分商品不支持配送到所选地区' },
            },
      // The address sheet's region picker.
      'GET /api/v1/cities': () => ({ body: cityTreeFixture }),
      'GET /api/v1/addresses': () => ({
        body: {
          items: [
            { ...addressFixture, id: '301', isDefault: true, receiverName: '林小姐' },
            { ...addressFixture, id: '302', isDefault: false, receiverName: '周先生' },
          ],
          page: 1,
          pageSize: 50,
          total: 2,
        },
      }),
    });
    await open();

    expect(await screen.findByText('林小姐')).toBeTruthy();
    expect(screen.getByText('部分商品不支持配送到所选地区')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更换收货地址' }));
    const sheet = document.getElementById('address-sheet') as HTMLElement;
    fireEvent.click(await within(sheet).findByRole('radio', { name: /周先生/ }));
    expect(await screen.findByRole('button', { name: '提交订单' })).toBeTruthy();
  });

  it('names the item over its purchase limit and offers the way back to the cart', async () => {
    serve({
      'POST /api/v1/checkout/preview': () => ({
        status: 409,
        body: {
          code: 'ORDER_PURCHASE_LIMIT_REACHED',
          message: '超出该商品的限购数量',
          details: { skuId: '103', limit: 1, purchased: 1 },
        },
      }),
    });
    await open({
      source: 'cart',
      cartItemIds: ['7'],
      kind: 'normal',
      names: { '103': '柔雾丝绒礼盒' },
    });

    expect(await screen.findByText('「柔雾丝绒礼盒」每人限购 1 件')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回购物车' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'switchTab',
        args: { url: '/pages/cart/index' },
      }),
    );
  });

  it('drops a coupon the server refused at submit, so the next tap is not the same refusal', async () => {
    let orders = 0;
    const seen = serve({
      'POST /api/v1/orders': () => {
        orders += 1;
        return orders === 1
          ? { status: 409, body: { code: 'COUPON_NOT_USABLE', message: '优惠券不可用' } }
          : { status: 201, body: orderFixture() };
      },
    });
    await open();

    expect(await screen.findByText('-¥10.00')).toBeTruthy();
    await ready();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({
          title: '优惠券已不可用，已为你取消使用，请确认金额后重新提交',
        }),
      }),
    );
    expect(await screen.findByText('不使用')).toBeTruthy();
    await ready();
    fireEvent.click(submitButton());
    await waitFor(() => expect(orders).toBe(2));
    const second = seen.filter((r) => r.key === 'POST /api/v1/orders')[1]?.body;
    expect(second).toMatchObject({ userCouponId: null, expectedPayableAmount: '126.00' });
  });
});

describe('确认订单 — signing in on the page', () => {
  it('sends the SMS login back to 确认订单, where the draft still is', async () => {
    useCheckoutDraft.setState({ draft: buyNow });
    useSession.setState({ session: { status: 'phone-required', bindToken: 'b' } });
    await renderPage(<CheckoutPage />);
    fireEvent.click(screen.getByRole('button', { name: '短信验证码登录' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: {
          url: `/pages/login/index?mode=sms&redirect=${encodeURIComponent('{"route":"checkout","params":{}}')}`,
        },
      }),
    );
  });
});
