import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  systemFailedJobList,
  systemFailedJobResolve,
} from '@shop/contracts/system/system.jobs.contract';
import { failedJobItemExample } from '@shop/contracts/system/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { FailedJobsPage } from './failed-jobs';

function stubApi(resolved: boolean): StubCall[] {
  return stubRoutes([
    on(systemFailedJobList, { items: [failedJobItemExample], total: 1, page: 1, pageSize: 20 }),
    on(systemFailedJobResolve, { resolved }),
  ]);
}

const handler = { ...testIdentity, permissions: ['system:job:handle'] };

afterEach(() => {
  resetApiConfig();
});

describe('失败的后台任务', () => {
  it('OPS-020 — names the job in words, never its id', async () => {
    stubApi(true);
    renderAdmin(<FailedJobsPage />, { identity: handler });
    expect(await screen.findByText('补扫超时未支付订单')).toBeInTheDocument();
    expect(screen.queryByText('order.sweepExpiredOrders')).toBeNull();
  });

  it('says why in Chinese and keeps the raw text under 技术详情', async () => {
    stubApi(true);
    renderAdmin(<FailedJobsPage />, { identity: handler });
    expect(
      await screen.findByText('重试 3 次后仍然失败，请联系技术人员查看服务器日志'),
    ).toBeInTheDocument();
    expect(screen.queryByText('connect ETIMEDOUT')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '技术详情' }));
    expect(await screen.findByText('connect ETIMEDOUT')).toBeInTheDocument();
  });

  it('OPS-020 — says so when somebody else marked the row first', async () => {
    const calls = stubApi(false);
    renderAdmin(<FailedJobsPage />, { identity: handler });
    await userEvent.click(await screen.findByRole('button', { name: '标记已处理' }));
    const ask = await screen.findByText('标记为已处理？');
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: /确\s*定/ }));

    expect(await screen.findByText('这条记录已被其他人处理')).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/admin-api/failed-jobs/12/resolve'))).toBe(
        true,
      );
    });
  });
});
