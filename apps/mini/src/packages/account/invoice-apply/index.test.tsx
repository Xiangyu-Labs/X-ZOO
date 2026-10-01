import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import {
  invoiceTitleFixture,
  orderInvoiceFixture,
  paidOrderFixture,
  personalTitleFixture,
} from '@/test/invoice-fixture';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import InvoiceApplyPage from './index';

const routes = {
  'GET /api/v1/orders/9001': () => ({ body: paidOrderFixture }),
  'GET /api/v1/invoice-titles': () => ({
    body: page([personalTitleFixture, invoiceTitleFixture]),
  }),
};

describe('申请开票', () => {
  beforeEach(() => {
    signIn();
    taroFake.routerParams = { orderId: '9001' };
  });

  it('sends the default title with a remark and opens the record', async () => {
    const seen = serveApi({
      ...routes,
      'POST /api/v1/orders/9001/invoice': () => ({ status: 201, body: orderInvoiceFixture }),
    });
    await renderPage(<InvoiceApplyPage />);

    const company = await screen.findByRole('radio', { name: /^深圳某某科技有限公司/ });
    expect(company.getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '明细开 日用品' } });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/orders/9001/invoice')?.body).toEqual({
        headerType: 'company',
        invoiceType: 'plain',
        name: '深圳某某科技有限公司',
        dutyNumber: '91440300MA5XXXXX1B',
        email: 'finance@example.com',
        remark: '明细开 日用品',
      }),
    );
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/account/invoice/index?id=3001' },
      }),
    );
  });

  it('sends another title when picked, and explains an order already asked for', async () => {
    const seen = serveApi({
      ...routes,
      'POST /api/v1/orders/9001/invoice': () => ({
        status: 409,
        body: { code: 'ORDER_INVOICE_ALREADY_OPEN', message: '该订单已有开票申请' },
      }),
    });
    await renderPage(<InvoiceApplyPage />);

    fireEvent.click(await screen.findByRole('radio', { name: /^李四/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/orders/9001/invoice')?.body).toEqual({
        headerType: 'personal',
        invoiceType: 'plain',
        name: '李四',
      }),
    );
    await waitFor(() => expect(taroFake.calls.map((c) => c.api)).toContain('showModal'));
  });

  it('makes the invoice out for what was paid less what was refunded', async () => {
    serveApi({
      ...routes,
      'GET /api/v1/orders/9001': () => ({
        body: { ...paidOrderFixture, refundedAmount: '18.00', invoiceAmount: '100.00' },
      }),
    });
    const { container } = await renderPage(<InvoiceApplyPage />);
    await screen.findByRole('radio', { name: /^深圳某某科技有限公司/ });
    expect(screen.getByLabelText('开票金额 100 元')).toBeTruthy();
    expect(container.textContent).not.toContain('118');
  });

  it('says the order cannot be invoiced instead of a form the server refuses', async () => {
    serveApi({
      ...routes,
      'GET /api/v1/orders/9001': () => ({
        body: { ...paidOrderFixture, invoiceRequestable: false, invoiceAmount: '0.00' },
      }),
    });
    await renderPage(<InvoiceApplyPage />);
    await screen.findByText('这个订单暂不能申请开票');
    expect(screen.queryByRole('button', { name: '提交申请' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开票记录' }));
    expect(taroFake.calls).toContainEqual({
      api: 'redirectTo',
      args: { url: '/packages/account/invoices/index?tab=records' },
    });
  });
});
