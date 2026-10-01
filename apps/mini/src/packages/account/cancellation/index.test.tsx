import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import CancellationPage from './index';

const agreement = {
  key: 'cancellation',
  title: '注销协议',
  content: '<p>注销前请确认订单均已完成。</p>',
  updatedAt: null,
};
const pending = {
  id: '31',
  userId: '7',
  nickname: '小明',
  phone: '138****8000',
  reason: '不再使用了',
  status: 'pending',
  reviewRemark: null,
  reviewedAt: null,
  createdAt: '2026-09-20T10:00:00+08:00',
};

describe('注销账号', () => {
  beforeEach(() => signIn());

  it('asks for the agreement, confirms, files the request and signs out', async () => {
    const seen = serveApi({
      'GET /api/v1/account-cancellations/current': () => ({ body: { request: null } }),
      'GET /api/v1/agreements/cancellation': () => ({ body: agreement }),
      'POST /api/v1/account-cancellations': () => ({ status: 201, body: pending }),
      'DELETE /api/v1/auth/sessions/current': () => ({ body: { ok: true } }),
    });
    await renderPage(<CancellationPage />);

    const submit = await screen.findByRole('button', { name: '申请注销' });
    await waitFor(() => expect(submit.getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(submit);
    expect(seen.map((r) => r.key)).not.toContain('POST /api/v1/account-cancellations');
    // The refused tap's handler settles before the button takes another.
    await waitFor(() => expect(submit.className).not.toContain('shop-btn--loading'));

    fireEvent.click(screen.getByRole('checkbox', { name: '我已阅读并同意《注销协议》' }));
    fireEvent.change(screen.getByLabelText('注销原因'), { target: { value: '不再使用了' } });
    fireEvent.click(submit);

    expect(await screen.findByText('已提交注销申请')).toBeTruthy();
    expect(seen.find((r) => r.key === 'POST /api/v1/account-cancellations')?.body).toEqual({
      reason: '不再使用了',
    });
    expect(useSession.getState().session.status).not.toBe('signed-in');
  });

  it('shows a pending request and withdraws it', async () => {
    let request: typeof pending | null = pending;
    const seen = serveApi({
      'GET /api/v1/account-cancellations/current': () => ({ body: { request } }),
      'GET /api/v1/agreements/cancellation': () => ({ body: agreement }),
      'DELETE /api/v1/account-cancellations/current': () => {
        const withdrawn = { ...pending, status: 'withdrawn' };
        request = null;
        return { body: withdrawn };
      },
    });
    await renderPage(<CancellationPage />);

    expect(await screen.findByText('注销申请审核中')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/account-cancellations/current'),
    );
    expect(await screen.findByRole('button', { name: '申请注销' })).toBeTruthy();
  });
});
