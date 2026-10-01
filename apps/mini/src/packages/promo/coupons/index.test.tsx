import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClaimableCoupon } from '@/features/coupon/claim-state';
import { useSession } from '@/session/session';
import { userCouponFixture } from '@/test/checkout-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { routeQueryKey } from '@shop/api-client/react';
import { taroFake } from '@/test/taro-fake/taro';
import CouponCenterPage from './index';

function coupon(id: string, patch: Partial<ClaimableCoupon> = {}): ClaimableCoupon {
  return {
    templateId: id,
    name: `券 ${id}`,
    discountAmount: '5.00',
    minSpend: '0.00',
    scope: 'all_products',
    validityMode: 'days_after_claim',
    validFrom: null,
    validTo: null,
    validDays: 7,
    claimTo: null,
    isUnlimitedSupply: false,
    remainingCount: 10,
    perUserLimit: 1,
    claimedCount: 0,
    canClaim: true,
    ...patch,
  };
}

const paged = (items: ClaimableCoupon[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

function serve(items: ClaimableCoupon[], claim: () => { status?: number; body: unknown }) {
  return serveApi({
    'GET /api/v1/coupons': () => ({ body: paged(items) }),
    'GET /api/v1/coupons/new-user': () => ({ body: { items: [coupon('90', { canClaim: null })] } }),
    'POST /api/v1/coupons/1/claims': claim,
  });
}

const navigatedTo = () =>
  taroFake.calls
    .filter((call) => call.api === 'navigateTo')
    .map((call) => (call.args as { url: string }).url);

describe('领券中心', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
  });

  it('claims a coupon', async () => {
    const seen = serve([coupon('1')], () => ({
      status: 201,
      body: {
        coupon: { ...userCouponFixture('501', '0.00', '5.00'), templateId: '1' },
        remainingCount: 9,
      },
    }));
    const { client } = await renderPage(<CouponCenterPage />);
    // What other pages hold: 首页 (its 优惠券 block's states), 我的 (the coupon total), the
    // cart's coupon hint.
    const home = routeQueryKey('decor.pageHome');
    const me = routeQueryKey('decor.pageUserCenter', {});
    const usable = routeQueryKey('coupon.applicableList', { body: { lines: [] } });
    for (const key of [home, me, usable]) client.setQueryData(key, { cached: true });
    fireEvent.click(await screen.findByRole('button', { name: '立即领取 券 1' }));
    await waitFor(() =>
      expect(seen.some((r) => r.key === 'POST /api/v1/coupons/1/claims')).toBe(true),
    );
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual(
        expect.objectContaining({
          api: 'showToast',
          args: expect.objectContaining({ title: '领取成功' }),
        }),
      ),
    );
    for (const key of [home, me, usable]) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    // Marked stale, not fetched while hidden: each page asks again when it is shown.
    expect(seen.some((r) => r.key === 'GET /api/v1/pages/home')).toBe(false);
  });

  it('claims once for two quick taps, before the busy state has rendered', async () => {
    const seen = serve([coupon('1')], () => ({
      status: 201,
      body: {
        coupon: { ...userCouponFixture('501', '0.00', '5.00'), templateId: '1' },
        remainingCount: 9,
      },
    }));
    await renderPage(<CouponCenterPage />);
    const button = await screen.findByRole('button', { name: '立即领取 券 1' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual(
        expect.objectContaining({
          api: 'showToast',
          args: expect.objectContaining({ title: '领取成功' }),
        }),
      ),
    );
    expect(seen.filter((r) => r.key === 'POST /api/v1/coupons/1/claims')).toHaveLength(1);
  });

  it('shows 去使用 at the per-user limit and 已抢光 when none are left', async () => {
    serve(
      [coupon('1', { canClaim: false, claimedCount: 1 }), coupon('2', { remainingCount: 0 })],
      () => ({ body: {} }),
    );
    await renderPage(<CouponCenterPage />);
    fireEvent.click(await screen.findByRole('button', { name: '去使用 券 1' }));
    expect(navigatedTo()).toEqual(['/packages/goods/list/index?couponId=1']);
    expect(screen.getByText('已抢光')).toBeTruthy();
    expect(screen.getByText('已领 1/1 张')).toBeTruthy();
  });

  it('keeps 立即领取 while more may be claimed, and counts what is held', async () => {
    serve([coupon('1', { claimedCount: 1, perUserLimit: 3 })], () => ({ body: {} }));
    await renderPage(<CouponCenterPage />);
    await screen.findByRole('button', { name: '立即领取 券 1' });
    expect(screen.getByText('已领 1/3 张')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去使用' })).toBeTruthy();
  });

  it('words a refusal and refreshes the list', async () => {
    const seen = serve([coupon('1')], () => ({
      status: 409,
      body: { code: 'COUPON_SOLD_OUT', message: '该优惠券已被领完' },
    }));
    await renderPage(<CouponCenterPage />);
    fireEvent.click(await screen.findByRole('button', { name: '立即领取 券 1' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual(
        expect.objectContaining({
          api: 'showToast',
          args: expect.objectContaining({ title: '来晚了，券已抢光' }),
        }),
      ),
    );
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/coupons').length).toBeGreaterThan(1),
    );
  });

  it('asks a visitor to log in before claiming, and shows the new-user coupons', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'b' } });
    const seen = serve([coupon('1', { canClaim: null, claimedCount: null })], () => ({ body: {} }));
    await renderPage(<CouponCenterPage />);
    await screen.findByText('新人专享 · 登录即得');
    fireEvent.click(await screen.findByRole('button', { name: '立即领取 券 1' }));
    await waitFor(() => expect(navigatedTo()[0]).toMatch(/^\/pages\/login\/index\?redirect=/));
    expect(decodeURIComponent(navigatedTo()[0] ?? '')).toContain('"route":"couponCenter"');
    expect(seen.some((r) => r.key.startsWith('POST'))).toBe(false);
  });

  it('answers the share menu with the coupon center', async () => {
    serve([], () => ({ body: {} }));
    await renderPage(<CouponCenterPage />);
    await screen.findByText('暂时没有可领的券');
    expect(taroFake.shareHandlers.message?.()).toMatchObject({
      path: '/packages/promo/coupons/index',
    });
  });
});
