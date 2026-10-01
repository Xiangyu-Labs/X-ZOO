import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  couponAdminDetail,
  couponAdminGrant,
  couponAdminList,
  couponAdminSetStatus,
  couponAdminUpdate,
} from '@shop/contracts/coupon/coupon.admin.contract';
import type { CouponTemplateDetail, CouponTemplateListItem } from '@shop/contracts/coupon/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { CouponTemplatesPage } from './coupon-templates';

/**
 * The admin page as a component test: no browser, no server, one stub `fetch`.
 *
 * What is worth asserting on a kit-built page is the *wiring* — that the table
 * asks the right route, that permissions really hide the buttons, and that an
 * action sends the body the contract declares. The kit's own tests already
 * cover paging, sorting and form rendering, so this does not repeat them.
 */

const row: CouponTemplateListItem = {
  id: '7',
  name: '满 100 减 10',
  scope: 'all_products',
  claimMode: 'manual',
  status: 'active',
  discountAmount: '10.00',
  minSpend: '100.00',
  validityMode: 'days_after_claim',
  validFrom: null,
  validTo: null,
  validDays: 30,
  claimFrom: null,
  claimTo: null,
  isUnlimitedSupply: false,
  totalCount: 100,
  remainingCount: 97,
  issuedCount: 3,
  perUserLimit: 1,
  giftMinOrderAmount: null,
  sortOrder: 0,
  createdAt: '2026-06-01T10:00:00+08:00',
};

/**
 * What the detail route answers and the list row does not: the scope links.
 * This page renders no control for either, so they exist only to be carried
 * back out of the form untouched.
 */
const detail: CouponTemplateDetail = {
  ...row,
  scope: 'products',
  productIds: ['31', '42'],
  categoryIds: [],
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(couponAdminGrant, { granted: 3, skippedUserIds: [] }),
    on(couponAdminList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(couponAdminDetail, detail),
    on(couponAdminUpdate, detail),
    on(couponAdminSetStatus, { ...detail, status: 'disabled' }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const allPermissions = {
  ...testIdentity,
  permissions: [
    'coupon:template:read',
    'coupon:template:write',
    'coupon:template:delete',
    'coupon:grant:write',
  ],
};

describe('优惠券列表', () => {
  it('lists campaigns from the contract route', async () => {
    const calls = stubApi();
    renderAdmin(<CouponTemplatesPage />, { identity: allPermissions });

    expect(await screen.findByText('满 100 减 10')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    // Supply is shown as "what is left / what has gone out".
    expect(screen.getByText(/剩 97/)).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/coupons?');
    expect(calls[0]?.url).toContain('page=1');
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(<CouponTemplatesPage />, {
      identity: { ...testIdentity, permissions: ['coupon:template:read'] },
    });

    await screen.findByText('满 100 减 10');
    expect(screen.queryByRole('button', { name: '新建优惠券' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发放' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('toggles the status through the sub-resource, not the edit form', async () => {
    const calls = stubApi();
    renderAdmin(<CouponTemplatesPage />, { identity: allPermissions });
    await screen.findByText('满 100 减 10');

    await userEvent.click(screen.getByRole('button', { name: '停用' }));
    // Switching off is customer-visible, so it asks first.
    const popup = (await screen.findByText(/^停用优惠券「/)).closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('停用') }));

    await waitFor(() => {
      const toggle = calls.find((call) => call.method === 'POST');
      expect(toggle?.url).toContain('/admin-api/coupons/7/status');
      expect(toggle?.body).toEqual({ status: 'disabled' });
    });
  });

  /**
   * The bug this is pinned against: 编辑 opened a form seeded from the
   * list row, which has no `productIds`, so saving an unrelated field posted
   * the schema's `[]` default and unlinked every product the coupon applied to.
   */
  it('loads the whole template before editing, and keeps the scope links it does not render', async () => {
    const calls = stubApi();
    renderAdmin(<CouponTemplatesPage />, { identity: allPermissions });
    await screen.findByText('满 100 减 10');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/admin-api/coupons/7'))).toBe(true);
    });
    // The name arrives from the detail, not from the row we clicked.
    await within(dialog).findByDisplayValue('满 100 减 10');

    await userEvent.click(within(dialog).getByRole('button', { name: '保 存' }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'PUT');
      expect(save?.url).toContain('/admin-api/coupons/7');
      expect((save?.body as { productIds: string[] }).productIds).toEqual(['31', '42']);
    });
  });

  it('grants to a pasted list of user ids', async () => {
    const calls = stubApi();
    renderAdmin(<CouponTemplatesPage />, { identity: allPermissions });
    await screen.findByText('满 100 减 10');

    await userEvent.click(screen.getByRole('button', { name: '发放' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), '1001, 1002\n1003');
    await userEvent.click(within(dialog).getByRole('button', { name: '发 放' }));

    await waitFor(() => {
      const grant = calls.find((call) => call.url.includes('/grants'));
      expect(grant?.method).toBe('POST');
      // Whitespace, commas and newlines all separate; ids stay strings.
      expect(grant?.body).toEqual({ userIds: ['1001', '1002', '1003'] });
    });
  });

  it('counts the pasted ids and refuses what is not an id under the field, before sending', async () => {
    const calls = stubApi();
    renderAdmin(<CouponTemplatesPage />, { identity: allPermissions });
    await screen.findByText('满 100 减 10');

    await userEvent.click(screen.getByRole('button', { name: '发放' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), '1001 1001 abc');
    expect(within(dialog).getByText('已识别 2 个用户 ID（上限 200）')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: '发 放' }));

    expect(await within(dialog).findByText('用户 ID 是数字，这些不是：abc')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/grants'))).toBe(false);
  });
});
