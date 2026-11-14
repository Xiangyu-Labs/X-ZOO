import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presaleAdminActivityList } from '@shop/contracts/presale/presale.admin.contract';
import type { PresaleActivityListItem } from '@shop/contracts/presale/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { withStubAssets } from '@/test/asset-source';
import { renderAdmin, testIdentity } from '@/test/render';

import { PresaleActivitiesPage } from './presale-activities';

/** Lists retain history and orders; configuration links to 商品编辑. */

const row: PresaleActivityListItem = {
  id: '7',
  productId: '12',
  productName: '明前龙井',
  title: '春茶预售 · 明前龙井',
  intro: '付款后 15 天内发货',
  imageUrl: 'https://example.test/p.png',
  status: 'active',
  paymentMode: 'full',
  price: '59.00',
  originalPrice: '88.00',
  stock: 480,
  sales: 20,
  totalQuota: 500,
  perOrderQuantity: 2,
  startAt: '2026-05-01T08:00:00+08:00',
  endAt: '2026-07-01T08:00:00+08:00',
  shipAfterDays: 15,
  sortOrder: 0,
  createdAt: '2026-05-01T08:00:00+08:00',
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(presaleAdminActivityList, { items: [row], total: 1, page: 1, pageSize: 20 }),
  ]);
}

// The 状态 column reads the window against the clock, so the clock is pinned
// inside the row's 2026-05-01 – 2026-07-01 window. Only `Date` is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-01T12:00:00+08:00'));
});

afterEach(() => {
  vi.useRealTimers();
  resetApiConfig();
});

const allPermissions = {
  ...testIdentity,
  permissions: [
    'catalog:product:write',
    'presale:activity:read',
    'presale:activity:write',
    'presale:activity:delete',
  ],
};

describe('预售活动', () => {
  it('lists campaigns from the contract route', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<PresaleActivitiesPage />), { identity: allPermissions });

    expect(await screen.findByText('春茶预售 · 明前龙井')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('全款预售')).toBeInTheDocument();
    // Supply reads as "what is left / what has gone out / the cap".
    expect(screen.getByText(/剩 480/)).toBeInTheDocument();
    // The 发货承诺 is a sentence, not a bare integer an operator has to decode.
    expect(screen.getByText('付款后 15 天内')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/presale-activities?');
    expect(calls[0]?.url).toContain('page=1');
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(withStubAssets(<PresaleActivitiesPage />), {
      identity: { ...testIdentity, permissions: ['presale:activity:read'] },
    });

    await screen.findByText('春茶预售 · 明前龙井');
    expect(screen.queryByRole('link', { name: '到商品页设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('says 未开始 before the window and 已结束 after it while the status is still active', async () => {
    vi.setSystemTime(new Date('2026-04-01T12:00:00+08:00'));
    stubApi();
    const first = renderAdmin(withStubAssets(<PresaleActivitiesPage />), {
      identity: allPermissions,
    });
    expect(await screen.findByText('未开始')).toBeInTheDocument();
    first.unmount();

    vi.setSystemTime(new Date('2026-08-01T12:00:00+08:00'));
    renderAdmin(withStubAssets(<PresaleActivitiesPage />), { identity: allPermissions });
    expect(await screen.findByText('已结束')).toBeInTheDocument();
    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
  });

  it('links editing to the product page without opening a second activity form', async () => {
    const calls = stubApi();
    renderAdmin(withStubAssets(<PresaleActivitiesPage />), { identity: allPermissions });
    const link = await screen.findByRole('link', { name: '编辑' });
    expect(link).toHaveAttribute('href', '/admin/catalog/products/12');
    expect(screen.getByRole('link', { name: '到商品页设置' })).toHaveAttribute(
      'href',
      '/admin/catalog/products',
    );
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
