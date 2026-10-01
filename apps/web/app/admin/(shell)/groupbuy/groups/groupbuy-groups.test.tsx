import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { groupbuyGroupDetailExample, groupbuyGroupExample } from '@shop/contracts/groupbuy/schemas';
import {
  groupbuyAdminGroupComplete,
  groupbuyAdminGroupDetail,
  groupbuyAdminGroupList,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { GroupbuyGroupsPage } from './groupbuy-groups';

/**
 * 拼团列表 as a component test.
 *
 * The one action on this page that invents data is 立即成团, so that is what is
 * asserted hardest: it hangs off its own permission atom, it goes to the
 * `completion` sub-resource, and the operator is never asked to type their own
 * name into it — `handle()` writes the audit row.
 */

/** The example team is 2 / 3. */
const fullTeam = { ...groupbuyGroupExample, seatsTaken: groupbuyGroupExample.seatsTotal };

function stubApi(team = groupbuyGroupExample): StubCall[] {
  return stubRoutes([
    on(groupbuyAdminGroupDetail, groupbuyGroupDetailExample),
    on(groupbuyAdminGroupList, { items: [team], total: 1, page: 1, pageSize: 20 }),
    on(groupbuyAdminGroupComplete, {
      ...groupbuyGroupDetailExample,
      seatsTaken: groupbuyGroupDetailExample.seatsTotal,
      status: 'succeeded',
      virtuallyFilled: false,
    }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const allPermissions = {
  ...testIdentity,
  permissions: ['groupbuy:group:read', 'groupbuy:group:complete'],
};

describe('拼团列表', () => {
  it('shows a team as seats taken out of seats needed', async () => {
    const calls = stubApi();
    renderAdmin(<GroupbuyGroupsPage />, { identity: allPermissions });

    expect(await screen.findByText('三人成团 · 坚果礼盒')).toBeInTheDocument();
    // Seats, not a participant count: an unpaid order holds nothing.
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByText('拼团中')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/groupbuy-groups?');
  });

  it('does not offer 立即成团 on a team that is not full', async () => {
    // The server refuses it (GROUPBUY_VIRTUAL_FILL_DISABLED): no 虚拟成团.
    stubApi();
    renderAdmin(<GroupbuyGroupsPage />, { identity: allPermissions });

    await screen.findByText('三人成团 · 坚果礼盒');
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即成团' })).not.toBeInTheDocument();
  });

  it('keeps 立即成团 behind its own permission atom', async () => {
    stubApi(fullTeam);
    renderAdmin(<GroupbuyGroupsPage />, {
      identity: { ...testIdentity, permissions: ['groupbuy:group:read'] },
    });

    await screen.findByText('三人成团 · 坚果礼盒');
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '立即成团' })).not.toBeInTheDocument();
  });

  it('lists everyone who ever joined, including who left', async () => {
    stubApi();
    renderAdmin(<GroupbuyGroupsPage />, { identity: allPermissions });
    await screen.findByText('三人成团 · 坚果礼盒');

    await userEvent.click(screen.getByRole('button', { name: '详情' }));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('小红')).toBeInTheDocument();
    // The leader's own row, with the order number the seat was paid for.
    expect(within(drawer).getByText('202609221000000000000001')).toBeInTheDocument();
    expect(within(drawer).getAllByText('团长').length).toBeGreaterThan(0);
  });

  it('completes a full team through the completion sub-resource', async () => {
    const calls = stubApi(fullTeam);
    renderAdmin(<GroupbuyGroupsPage />, { identity: allPermissions });
    await screen.findByText('三人成团 · 坚果礼盒');

    await userEvent.click(screen.getByRole('button', { name: '立即成团' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), '客服协助成团');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认成团' }));

    await waitFor(() => {
      const complete = calls.find((call) => call.method === 'POST');
      expect(complete?.url).toContain('/admin-api/groupbuy-groups/501/completion');
      // Only the reason: the operator is `ctx.actor`, not a string in the body.
      expect(complete?.body).toEqual({ reason: '客服协助成团' });
    });
  });
});
