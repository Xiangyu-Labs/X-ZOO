import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExpressCompanyRow } from '@shop/contracts/shipping/schemas';
import {
  expressCompanyAdminList,
  expressCompanySetStatus,
  expressCompanyUpdate,
} from '@shop/contracts/shipping/shipping.express.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { ExpressCompaniesPage } from './express-companies';

/**
 * 快递公司 as a component test: no browser, no server, one stub `fetch`.
 *
 * What is asserted is the wiring — which route the table asks, that the
 * permission really hides the write controls, and that the 启用 switch goes
 * through the status sub-resource rather than the edit form. Paging, sorting
 * and form rendering belong to the kit's own tests.
 */

const row: ExpressCompanyRow = {
  id: '12',
  code: 'SF',
  name: '顺丰速运',
  sortOrder: 100,
  isEnabled: true,
  wechatDeliveryId: 'SF',
  createdAt: '2026-01-01T00:00:00+08:00',
  updatedAt: '2026-01-01T00:00:00+08:00',
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(expressCompanyAdminList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(expressCompanyUpdate, row),
    on(expressCompanySetStatus, { ...row, isEnabled: false }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const writer = {
  ...testIdentity,
  permissions: ['shipping:express:read', 'shipping:express:write'],
};

describe('快递公司', () => {
  it('lists carriers from the contract route', async () => {
    const calls = stubApi();
    renderAdmin(<ExpressCompaniesPage />, { identity: writer });

    expect(await screen.findByText('顺丰速运')).toBeInTheDocument();
    // 编码 and 微信快递编码 are both SF for 顺丰.
    expect(screen.getAllByText('SF')).toHaveLength(2);
    expect(calls[0]?.url).toContain('/admin-api/shipping/express-companies?');
    expect(calls[0]?.url).toContain('page=1');
  });

  it('hides every write control from a read-only admin', async () => {
    stubApi();
    renderAdmin(<ExpressCompaniesPage />, {
      identity: { ...testIdentity, permissions: ['shipping:express:read'] },
    });

    await screen.findByText('顺丰速运');
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    // The fallback still tells a read-only admin what the state is (so does the
    // column header, hence `getAllByText`).
    expect(screen.getAllByText('启用').length).toBeGreaterThan(1);
  });

  it('disables a carrier through the status sub-resource', async () => {
    const calls = stubApi();
    renderAdmin(<ExpressCompaniesPage />, { identity: writer });
    await screen.findByText('顺丰速运');

    await userEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      const flip = calls.find((call) => call.method === 'POST');
      expect(flip?.url).toContain('/admin-api/shipping/express-companies/12/status');
      expect(flip?.body).toEqual({ isEnabled: false });
    });
  });
});
