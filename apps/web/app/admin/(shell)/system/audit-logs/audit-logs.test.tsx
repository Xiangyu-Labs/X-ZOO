import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { systemAuditLogList } from '@shop/contracts/system/system.settings.contract';
import { auditLogItemExample, type AuditLogItem } from '@shop/contracts/system/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { AuditLogsPage } from './audit-logs';

const broke: AuditLogItem = {
  ...auditLogItemExample,
  id: '9002',
  routeId: 'catalog.adminProductUpdate',
  operation: '编辑商品',
  method: 'PUT',
  path: '/admin-api/products/12',
  target: 'product:12',
  targetText: '商品 #12',
  status: 500,
  errorCode: 'INTERNAL',
  errorMessage: '服务器开小差了，请稍后再试',
  errorDetail: 'TypeError: Cannot read properties of undefined',
};

const reader = { ...testIdentity, permissions: ['system:audit:read'] };

afterEach(() => {
  resetApiConfig();
});

describe('操作日志', () => {
  it('lists a failed save in words, with the inside story only in 详情', async () => {
    stubRoutes([
      on(systemAuditLogList, {
        items: [broke, auditLogItemExample],
        total: 2,
        page: 1,
        pageSize: 20,
      }),
    ]);
    renderAdmin(<AuditLogsPage />, { identity: reader });

    expect(await screen.findByText('服务器开小差了，请稍后再试')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText('编辑商品')).toBeInTheDocument();
    expect(screen.getByText('商品 #12')).toBeInTheDocument();
    expect(screen.queryByText(/TypeError/)).toBeNull();
    expect(screen.queryByText(/catalog\.adminProductUpdate|\/admin-api\/|product:12/)).toBeNull();

    const row = screen.getByText('服务器开小差了，请稍后再试').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: '详情' }));
    expect(
      await screen.findByText(
        /PUT \/admin-api\/products\/12（catalog\.adminProductUpdate）\s+对象：product:12\s+500 INTERNAL\s+TypeError: Cannot read properties of undefined/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(broke.requestId, { selector: '.ant-drawer *' })).toBeInTheDocument();
  });
});
