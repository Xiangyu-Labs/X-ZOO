import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  paymentAdminEffectList,
  paymentAdminEffectRetry,
} from '@shop/contracts/payment/payment.admin.contract';
import {
  paymentEffectExample,
  type PaymentEffectRetryResult,
} from '@shop/contracts/payment/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { PaymentEffectsPage } from './payment-effects';

const handler = { ...testIdentity, permissions: ['payment:effect:handle'] };

async function pressRetry(result: PaymentEffectRetryResult) {
  stubRoutes([
    on(paymentAdminEffectList, {
      items: [paymentEffectExample],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    on(paymentAdminEffectRetry, result),
  ]);
  renderAdmin(<PaymentEffectsPage />, { identity: handler });
  await userEvent.click(await screen.findByRole('button', { name: '重试' }));
  const ask = await screen.findByText('重新排队执行这个任务？');
  const popup = ask.closest('.ant-popover') as HTMLElement;
  await userEvent.click(within(popup).getByRole('button', { name: /确\s*定/ }));
}

afterEach(() => {
  resetApiConfig();
});

describe('待处理任务 — 重试', () => {
  it('says the task was re-queued, not that it ran', async () => {
    await pressRetry({
      effect: { ...paymentEffectExample, status: 'pending' },
      succeeded: true,
      message: '已重新排队，几秒内由后台执行，结果请稍后在列表里查看',
    });
    expect(
      await screen.findByText('已重新排队，几秒内由后台执行，结果请稍后在列表里查看'),
    ).toBeInTheDocument();
  });

  it('says so when the task had already been dealt with, and does not claim a re-queue', async () => {
    await pressRetry({
      effect: { ...paymentEffectExample, status: 'done', lastError: null, lastErrorSummary: null },
      succeeded: false,
      message: '该任务已经执行成功，不需要再重试',
    });
    await waitFor(() => {
      expect(screen.getByText('该任务已经执行成功，不需要再重试')).toBeInTheDocument();
    });
    expect(screen.queryByText('已重新排队')).toBeNull();
  });
});
