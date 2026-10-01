import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  paymentAdminExceptionList,
  paymentAdminExceptionRecheck,
} from '@shop/contracts/payment/payment.admin.contract';
import {
  paymentExceptionDetailExample,
  paymentExceptionExample,
  type PaymentExceptionListItem,
} from '@shop/contracts/payment/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { outcomeText, PaymentExceptionsPage } from './payment-exceptions';

const handler = { ...testIdentity, permissions: ['payment:exception:handle'] };

const failed: PaymentExceptionListItem = {
  ...paymentExceptionExample,
  status: 'refund_failed',
  lastErrorSummary: '微信支付商户号余额不足，请到商户平台充值后重试',
  lastError: 'refused NOT_ENOUGH: 余额不足',
};

afterEach(() => {
  resetApiConfig();
});

describe('异常支付', () => {
  it('says why the refund waits in Chinese and keeps the raw text under 技术详情', async () => {
    stubRoutes([
      on(paymentAdminExceptionList, { items: [failed], total: 1, page: 1, pageSize: 20 }),
    ]);
    renderAdmin(<PaymentExceptionsPage />, { identity: handler });

    expect(
      await screen.findByText('微信支付商户号余额不足，请到商户平台充值后重试'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/NOT_ENOUGH/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '技术详情' }));
    expect(await screen.findByText('refused NOT_ENOUGH: 余额不足')).toBeInTheDocument();
  });

  it('reports what the 查询结果 found, not that a button was pressed', async () => {
    const refunding = { ...paymentExceptionExample, status: 'refunding' as const };
    stubRoutes([
      on(paymentAdminExceptionList, { items: [refunding], total: 1, page: 1, pageSize: 20 }),
      on(paymentAdminExceptionRecheck, {
        ...paymentExceptionDetailExample,
        status: 'refunding',
      }),
    ]);
    renderAdmin(<PaymentExceptionsPage />, { identity: handler });

    await userEvent.click(await screen.findByRole('button', { name: '查询结果' }));
    const ask = await screen.findByText('向微信查询这笔退款的结果？');
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(screen.getByText('微信还在处理这笔退款')).toBeInTheDocument();
    });
    expect(screen.queryByText('已查询')).toBeNull();
  });
});

describe('outcomeText', () => {
  const row = (status: PaymentExceptionListItem['status'], why: string | null = null) => ({
    ...paymentExceptionDetailExample,
    status,
    lastErrorSummary: why,
  });

  it('is a warning with the reason for a refund that did not go through', () => {
    expect(outcomeText(row('refund_failed', '余额不足'), 'refund')).toEqual({
      level: 'warning',
      text: '退款没有成功：余额不足',
    });
  });

  it('says 已退款 only for a refunded row', () => {
    expect(outcomeText(row('refunded'), 'recheck').text).toBe('已退款');
    expect(outcomeText(row('refunding'), 'refund').level).toBe('info');
    expect(outcomeText(row('refund_unknown'), 'recheck').level).toBe('warning');
  });
});
