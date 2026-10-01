import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  couponAdminRevokeUserCoupon,
  couponAdminUserCouponList,
} from '@shop/contracts/coupon/coupon.admin.contract';
import { userCouponExample, type AdminUserCoupon } from '@shop/contracts/coupon/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { UserCouponsPage } from './user-coupons';

/**
 * 已领取记录: the list, and 作废 — offered on a coupon the console handed out
 * and nobody has spent, and on nothing else.
 */

const granted: AdminUserCoupon = {
  ...userCouponExample,
  id: '9001',
  title: '后台补偿券',
  sourceKind: 'admin_grant',
  userId: '101',
  userNickname: '小明',
  sourceOrderId: null,
};
const claimed: AdminUserCoupon = {
  ...granted,
  id: '9002',
  title: '自己领的券',
  sourceKind: 'claim',
};
const spent: AdminUserCoupon = {
  ...granted,
  id: '9003',
  title: '已用掉的券',
  status: 'used',
  usedAt: '2026-02-01T10:00:00+08:00',
};

function stubApi(revoked: 0 | 1 = 1): StubCall[] {
  return stubRoutes([
    on(couponAdminUserCouponList, {
      items: [granted, claimed, spent],
      total: 3,
      page: 1,
      pageSize: 20,
    }),
    on(couponAdminRevokeUserCoupon, { revoked }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const granter = {
  ...testIdentity,
  permissions: ['coupon:user-coupon:read', 'coupon:grant:write'],
};

describe('已领取记录 — 作废', () => {
  it('offers 作废 only on an unused coupon the console handed out', async () => {
    stubApi();
    renderAdmin(<UserCouponsPage />, { identity: granter });
    await screen.findByText('后台补偿券');

    const buttons = screen.getAllByRole('button', { name: zhName('作废') });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.closest('tr')).toHaveTextContent('后台补偿券');
  });

  it('asks first, then revokes through the revocation sub-resource', async () => {
    const calls = stubApi();
    renderAdmin(<UserCouponsPage />, { identity: granter });
    await screen.findByText('后台补偿券');

    await userEvent.click(screen.getByRole('button', { name: zhName('作废') }));
    const ask = await screen.findByText('作废「后台补偿券」？');
    expect(calls.some((call) => call.path.includes('/revocation'))).toBe(false);
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('作废') }));

    await waitFor(() => {
      const revoke = calls.find((call) => call.path === '/admin-api/user-coupons/9001/revocation');
      expect(revoke?.method).toBe('POST');
    });
    expect(await screen.findByText('已作废')).toBeInTheDocument();
  });

  it('says so when the coupon was no longer there to revoke', async () => {
    stubApi(0);
    renderAdmin(<UserCouponsPage />, { identity: granter });
    await screen.findByText('后台补偿券');

    await userEvent.click(screen.getByRole('button', { name: zhName('作废') }));
    const popup = (await screen.findByText('作废「后台补偿券」？')).closest(
      '.ant-popover',
    ) as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('作废') }));

    expect(await screen.findByText('这张券已被使用或已作废，未作废')).toBeInTheDocument();
  });

  it('hides 作废 from an operator who may only read', async () => {
    stubApi();
    renderAdmin(<UserCouponsPage />, {
      identity: { ...testIdentity, permissions: ['coupon:user-coupon:read'] },
    });
    await screen.findByText('后台补偿券');
    expect(screen.queryByRole('button', { name: zhName('作废') })).not.toBeInTheDocument();
  });
});
