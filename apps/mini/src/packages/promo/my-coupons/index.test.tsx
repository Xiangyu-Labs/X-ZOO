import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import MyCouponsPage from './index';

const coupon = (id: string, title: string) => ({
  id,
  templateId: `9${id}`,
  title,
  discountAmount: '5.00',
  minSpend: '0.00',
  scope: 'all_products',
  status: 'unused',
  sourceKind: 'claim',
  validFrom: '2026-09-01T00:00:00Z',
  validTo: '2026-09-30T00:00:00Z',
  usedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
});

function serve() {
  return serveApi({
    'GET /api/v1/user-coupons': () => ({
      body: { items: [coupon('1', '满减券')], total: 1, page: 1, pageSize: 20 },
    }),
  });
}

describe('我的优惠券', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
  });

  it('opens on 可使用 and sends 去使用 to the product list for the coupon template, not the wallet row', async () => {
    const seen = serve();
    await renderPage(<MyCouponsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '去使用 满减券' }));
    expect(taroFake.calls.at(-1)).toEqual({
      api: 'navigateTo',
      args: { url: '/packages/goods/list/index?couponId=91' },
    });
    expect(seen[0]?.query).toMatchObject({ state: 'unused' });
  });

  it('opens the tab the route names, and shows used coupons stamped', async () => {
    taroFake.routerParams = { state: 'used' };
    const seen = serve();
    await renderPage(<MyCouponsPage />);
    await screen.findByText('已使用', { selector: '.shop-coupon__stamp' });
    expect(seen[0]?.query).toMatchObject({ state: 'used' });
  });

  it('asks again when it comes back, as an order may have used or given back a coupon', async () => {
    const seen = serve();
    await renderPage(<MyCouponsPage />);
    await screen.findByRole('button', { name: '去使用 满减券' });
    taroFake.showPage();
    await waitFor(() => expect(seen).toHaveLength(2));
  });

  it('switches tabs', async () => {
    const seen = serve();
    await renderPage(<MyCouponsPage />);
    await screen.findByText('满减券');
    fireEvent.click(screen.getByRole('tab', { name: '已过期' }));
    await waitFor(() => expect(seen.at(-1)?.query).toMatchObject({ state: 'expired' }));
  });

  it('asks for a login first', async () => {
    useSession.setState({ session: { status: 'signed-out' } });
    const seen = serve();
    await renderPage(<MyCouponsPage />);
    await screen.findByText('登录后查看你的优惠券');
    expect(seen).toHaveLength(0);
  });
});
