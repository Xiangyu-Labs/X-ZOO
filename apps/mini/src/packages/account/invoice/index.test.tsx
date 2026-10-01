import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { routeQueryKey } from '@shop/api-client/react';
import { signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { orderInvoiceFixture } from '@/test/invoice-fixture';
import { renderPage, testQueryClient } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import InvoicePage from './index';

describe('发票详情', () => {
  beforeEach(() => {
    signIn();
    taroFake.routerParams = { id: '3001' };
  });

  it('withdraws a request after asking', async () => {
    let status = 'requested';
    const seen = serveApi({
      'GET /api/v1/invoices/3001': () => ({ body: { ...orderInvoiceFixture, status } }),
      'POST /api/v1/invoices/3001/cancel': () => {
        status = 'cancelled';
        return { body: { ...orderInvoiceFixture, status } };
      },
    });
    const client = testQueryClient();
    // 订单详情 offers 申请开票 again once the request is withdrawn.
    const orderKey = routeQueryKey('order.detail', { params: { id: '9001' } });
    client.setQueryData(orderKey, {});
    await renderPage(<InvoicePage />, client);

    expect(await screen.findByText('已提交，商家开具后会通知你')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/invoices/3001/cancel'),
    );
    expect(await screen.findByRole('button', { name: '重新申请' })).toBeTruthy();
    expect(client.getQueryState(orderKey)?.isInvalidated).toBe(true);
  });

  it('INVOICE-005 — reads 已作废 for an invoice the shop voided, and offers no new one for a refunded order', async () => {
    serveApi({
      'GET /api/v1/invoices/3001': () => ({
        body: {
          ...orderInvoiceFixture,
          status: 'cancelled',
          invoiceNumber: '24332000000012345678',
          voided: true,
          orderRefundedInFull: true,
        },
      }),
    });
    await renderPage(<InvoicePage />);
    expect(await screen.findByText('已作废')).toBeTruthy();
    expect(screen.getByText('订单已退款，商家已作废这张发票')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新申请' })).toBeNull();
  });

  it('goes back to the 订单详情 it was opened from for 查看订单, not to a second copy', async () => {
    serveApi({ 'GET /api/v1/invoices/3001': () => ({ body: orderInvoiceFixture }) });
    taroFake.pageStack = [
      { route: 'packages/order/detail/index', options: { id: '9001' } },
      { route: 'packages/account/invoice/index', options: { id: '3001' } },
    ];
    await renderPage(<InvoicePage />);
    fireEvent.click(await screen.findByRole('link', { name: '查看订单' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({ api: 'navigateBack', args: { delta: 1 } }),
    );
    expect(taroFake.calls.some((call) => call.api === 'navigateTo')).toBe(false);
  });

  it('asks again when it comes back, where the merchant may have issued it', async () => {
    let status = 'requested';
    serveApi({
      'GET /api/v1/invoices/3001': () => ({ body: { ...orderInvoiceFixture, status } }),
    });
    await renderPage(<InvoicePage />);
    expect(await screen.findByText('已提交，商家开具后会通知你')).toBeTruthy();

    status = 'issued';
    taroFake.showPage();
    expect(await screen.findByText('已开票')).toBeTruthy();
  });

  it('says why a request was not accepted', async () => {
    serveApi({
      'GET /api/v1/invoices/3001': () => ({
        body: { ...orderInvoiceFixture, status: 'rejected', remark: '税号与抬头不匹配' },
      }),
    });
    await renderPage(<InvoicePage />);
    expect(await screen.findByText('原因：税号与抬头不匹配')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新申请' }));
    await waitFor(() =>
      // In place of this 发票详情, which the new request then replaces in turn.
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/account/invoice-apply/index?orderId=9001' },
      }),
    );
  });
});
