import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import {
  invoiceTitleFixture,
  orderInvoiceFixture,
  personalTitleFixture,
} from '@/test/invoice-fixture';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import InvoicesPage from './index';

describe('发票', () => {
  beforeEach(() => signIn());

  it('lists the titles, sets a default and deletes one', async () => {
    const seen = serveApi({
      'GET /api/v1/invoice-titles': () => ({
        body: page([invoiceTitleFixture, personalTitleFixture]),
      }),
      'POST /api/v1/invoice-titles/7002/default': () => ({
        body: { ...personalTitleFixture, isDefault: true },
      }),
      'DELETE /api/v1/invoice-titles/7002': () => ({ status: 204, body: null }),
    });
    await renderPage(<InvoicesPage />);

    expect(await screen.findByText('企业 · 普通发票 · 税号 91440300MA5XXXXX1B')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '设为默认' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/invoice-titles/7002/default'),
    );
    fireEvent.click(screen.getByRole('button', { name: '删除「李四」' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/invoice-titles/7002'),
    );

    fireEvent.click(screen.getByRole('button', { name: '新增发票抬头' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/invoice-title-edit/index' },
      }),
    );
  });

  it('opens on 开票记录 and shows what each invoice was for', async () => {
    taroFake.routerParams = { tab: 'records' };
    serveApi({
      'GET /api/v1/invoices': () => ({
        body: page([orderInvoiceFixture, { ...orderInvoiceFixture, id: '3002', status: 'issued' }]),
      }),
    });
    await renderPage(<InvoicesPage />);

    expect(await screen.findAllByText('纯棉毛巾 等 3 件')).toHaveLength(2);
    expect(screen.getByText('待开票')).toBeTruthy();
    expect(screen.getByText('已开票')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '深圳某某科技有限公司，已开票，查看详情' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/invoice/index?id=3002' },
      }),
    );
  });

  it('asks again for 开票记录 when it comes back, where the merchant may have issued one', async () => {
    taroFake.routerParams = { tab: 'records' };
    let status = 'requested';
    const seen = serveApi({
      'GET /api/v1/invoices': () => ({ body: page([{ ...orderInvoiceFixture, status }]) }),
    });
    await renderPage(<InvoicesPage />);
    expect(await screen.findByText('待开票')).toBeTruthy();

    status = 'issued';
    taroFake.showPage();
    expect(await screen.findByText('已开票')).toBeTruthy();
    expect(seen.filter((r) => r.key === 'GET /api/v1/invoices')).toHaveLength(2);
  });
});
