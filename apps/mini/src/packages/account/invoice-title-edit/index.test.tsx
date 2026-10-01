import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { rejected, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { invoiceTitleFixture } from '@/test/invoice-fixture';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { useCreatedInvoiceTitle } from '../shared/invoice';
import InvoiceTitleEditPage from './index';

describe('新增 / 编辑发票抬头', () => {
  beforeEach(() => {
    signIn();
    taroFake.pageStackDepth = 2;
  });

  it('imports a title from WeChat and saves it', async () => {
    taroFake.invoiceTitle = {
      type: '0',
      title: '深圳某某科技有限公司',
      taxNumber: '91440300MA5XXXXX1B',
    };
    const seen = serveApi({
      'POST /api/v1/invoice-titles': () => ({ status: 201, body: invoiceTitleFixture }),
    });
    await renderPage(<InvoiceTitleEditPage />);

    fireEvent.click(screen.getByRole('link', { name: '从微信导入' }));
    await waitFor(() =>
      expect((screen.getByLabelText('单位名称') as HTMLInputElement).value).toBe(
        '深圳某某科技有限公司',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/invoice-titles')?.body).toEqual({
        headerType: 'company',
        invoiceType: 'plain',
        name: '深圳某某科技有限公司',
        dutyNumber: '91440300MA5XXXXX1B',
        isDefault: false,
      }),
    );
    await waitFor(() => expect(useCreatedInvoiceTitle.getState().id).toBe('7001'));
    expect(taroFake.calls.map((c) => c.api)).toContain('navigateBack');
  });

  it('shows the default title’s switch as fixed, and a non-default one as free', async () => {
    taroFake.routerParams = { id: '7001' };
    serveApi({ 'GET /api/v1/invoice-titles/7001': () => ({ body: invoiceTitleFixture }) });
    await renderPage(<InvoiceTitleEditPage />);
    const toggle = await screen.findByRole('switch', { name: '设为默认抬头' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('这是默认抬头；要换默认，请把其他抬头设为默认')).toBeTruthy();
  });

  it('asks for a 税号 before sending a company title', async () => {
    const seen = serveApi({});
    await renderPage(<InvoiceTitleEditPage />);
    fireEvent.change(screen.getByLabelText('单位名称'), { target: { value: '某公司' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('企业抬头需要填写税号')).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('shows a name WeChat rejects as an error on the name', async () => {
    serveApi({
      'POST /api/v1/invoice-titles': () =>
        rejected('USER_INVOICE_TITLE_REJECTED', '发票抬头包含不当信息，请修改后再保存'),
    });
    await renderPage(<InvoiceTitleEditPage />);
    fireEvent.click(screen.getByRole('radio', { name: '个人' }));
    fireEvent.change(screen.getByLabelText('抬头名称'), { target: { value: '违规测试' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('发票抬头包含不当信息，请修改后再保存')).toBeTruthy();
  });
});
