import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { invoiceAdminList, invoiceAdminVoid } from '@shop/contracts/order/order.invoice.contract';
import { orderInvoiceExample, type OrderInvoice } from '@shop/contracts/order/order.fulfil.schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { OrderInvoicesPage } from './order-invoices';

const issued: OrderInvoice = {
  ...orderInvoiceExample,
  status: 'issued',
  invoiceNumber: '24332000000012345678',
  issuedAt: '2026-02-04T10:00:00+08:00',
  orderRefundedInFull: true,
};

function stubApi(row: OrderInvoice = issued): StubCall[] {
  return stubRoutes([
    on(invoiceAdminList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(invoiceAdminVoid, {
      ...row,
      status: 'cancelled',
      issuedAt: null,
      voided: true,
    }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const writer = {
  ...testIdentity,
  permissions: ['order:invoice:read', 'order:invoice:write'],
};

describe('发票管理', () => {
  it('INVOICE-005 — tells finance to 冲红 an issued invoice whose order was refunded in full, and voids it only after confirming', async () => {
    const calls = stubApi();
    renderAdmin(<OrderInvoicesPage />, { identity: writer });

    expect(await screen.findByText('订单已全额退款，请到税务系统冲红')).toBeInTheDocument();
    expect(screen.getByText('已开票')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: zhName('作废') }));
    expect(
      await screen.findByText('请先在税务系统完成冲红。作废后买家可以重新申请开票。'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    const buttons = screen.getAllByRole('button', { name: zhName('作废') });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => {
      const voided = calls.find((call) => call.method === 'POST');
      expect(voided?.routeId).toBe('order.adminVoidInvoice');
      expect(voided?.params).toEqual({ id: issued.id });
    });
  });

  it('reads 已作废 for a voided invoice and offers nothing more', async () => {
    stubApi({ ...issued, status: 'cancelled', issuedAt: null, voided: true });
    renderAdmin(<OrderInvoicesPage />, { identity: writer });

    expect(await screen.findByText('已作废')).toBeInTheDocument();
    expect(screen.queryByText('订单已全额退款，请到税务系统冲红')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('作废') })).not.toBeInTheDocument();
  });

  it('hides 作废 from an admin who may only read invoices', async () => {
    stubApi();
    renderAdmin(<OrderInvoicesPage />, {
      identity: { ...testIdentity, permissions: ['order:invoice:read'] },
    });

    await screen.findByText('订单已全额退款，请到税务系统冲红');
    expect(screen.queryByRole('button', { name: zhName('作废') })).not.toBeInTheDocument();
  });
});
