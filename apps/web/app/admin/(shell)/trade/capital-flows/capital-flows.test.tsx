import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  paymentAdminCapitalFlowList,
  paymentAdminCapitalFlowSummary,
} from '@shop/contracts/payment/payment.admin.contract';
import { capitalFlowExample } from '@shop/contracts/payment/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { CapitalFlowsPage } from './capital-flows';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/trade/capital-flows',
  useSearchParams: () => new URLSearchParams(),
}));

const reader = { ...testIdentity, permissions: ['payment:flow:read'] };

afterEach(() => {
  resetApiConfig();
});

describe('<CapitalFlowsPage>', () => {
  it('refetches both the summary card and the table when clicking 刷新', async () => {
    let summaryCount = 0;
    const calls = stubRoutes([
      on(paymentAdminCapitalFlowList, {
        items: [capitalFlowExample],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
      on(paymentAdminCapitalFlowSummary, () => {
        summaryCount += 1;
        return {
          inAmount: summaryCount === 1 ? '120.00' : '250.00',
          outAmount: summaryCount === 1 ? '21.00' : '50.00',
          netAmount: summaryCount === 1 ? '99.00' : '200.00',
          count: summaryCount,
        };
      }),
    ]);

    renderAdmin(<CapitalFlowsPage />, { identity: reader });

    expect(await screen.findByText('P2602261200003001A7F3')).toBeInTheDocument();
    expect(await screen.findByText('¥120.00')).toBeInTheDocument();

    const listCallsBefore = calls.filter((c) => c.path === '/admin-api/capital-flows').length;
    const summaryCallsBefore = calls.filter(
      (c) => c.path === '/admin-api/capital-flows/summary',
    ).length;

    await userEvent.click(screen.getByRole('button', { name: /刷\s*新/ }));

    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/admin-api/capital-flows').length).toBeGreaterThan(
        listCallsBefore,
      );
      expect(
        calls.filter((c) => c.path === '/admin-api/capital-flows/summary').length,
      ).toBeGreaterThan(summaryCallsBefore);
    });
    expect(await screen.findByText('¥250.00')).toBeInTheDocument();
  });
});
