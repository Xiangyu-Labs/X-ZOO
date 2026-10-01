import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  userAdminApproveCancellation,
  userAdminCancellationList,
  userAdminRemarkCancellation,
} from '@shop/contracts/user/user.admin.contract';
import { cancellationRequestExample } from '@shop/contracts/user/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { CancellationsPage } from './cancellations';

const reviewer = {
  ...testIdentity,
  permissions: ['user:cancellation:read', 'user:cancellation:review'],
};

function stubApi() {
  return stubRoutes([
    on(userAdminCancellationList, {
      items: [cancellationRequestExample],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    on(userAdminApproveCancellation, { ...cancellationRequestExample, status: 'approved' }),
    on(userAdminRemarkCancellation, { ...cancellationRequestExample, reviewRemark: '已电话确认' }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

describe('注销申请', () => {
  it('a 备注 on its own asks for the text under the field and sends nothing', async () => {
    const calls = stubApi();
    renderAdmin(<CancellationsPage />, { identity: reviewer });
    await screen.findByText('不再使用了');

    await userEvent.click(screen.getByRole('button', { name: zhName('备注') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存备注' }));

    expect(await within(dialog).findByText('请填写备注')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await userEvent.type(within(dialog).getByLabelText('备注'), '已电话确认');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存备注' }));
    await waitFor(() => {
      const remark = calls.find((call) => call.routeId === userAdminRemarkCancellation.id);
      expect(remark?.body).toEqual({ remark: '已电话确认' });
    });
  });

  it('通过 with no remark leaves the remark out', async () => {
    const calls = stubApi();
    renderAdmin(<CancellationsPage />, { identity: reviewer });
    await screen.findByText('不再使用了');

    await userEvent.click(screen.getByRole('button', { name: zhName('通过') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认通过' }));

    await waitFor(() => {
      const approve = calls.find((call) => call.routeId === userAdminApproveCancellation.id);
      expect(approve?.body).toEqual({});
    });
  });
});
