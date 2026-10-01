import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { refundDetail } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import RefundDetailPage from './index';

const awaitingReturn = refundDetail({
  kind: 'return_and_refund',
  status: 'approved',
  returnStage: 'awaiting_shipment',
  returnAddress: { name: '售后部', phone: '02000000000', address: '广州市天河区某路 1 号' },
  logs: [
    {
      toStatus: 'applied',
      message: '买家发起退货退款申请',
      createdAt: '2026-02-26T13:00:00+08:00',
    },
    { toStatus: 'approved', message: null, createdAt: '2026-02-26T15:00:00+08:00' },
  ],
});

describe('售后详情', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    taroFake.routerParams = { id: '601' };
  });

  it('shows where a return stands, newest step first, with the address to copy', async () => {
    serveApi({ 'GET /api/v1/refunds/601': () => ({ body: awaitingReturn }) });
    await renderPage(<RefundDetailPage />);

    await screen.findByText('待寄回商品');
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]?.textContent).toContain('商家已同意');
    expect(steps[1]?.textContent).toContain('买家发起退货退款申请');

    fireEvent.click(screen.getByRole('button', { name: '复制退货地址' }));
    expect(taroFake.calls).toContainEqual({
      api: 'setClipboardData',
      args: { data: '售后部 02000000000 广州市天河区某路 1 号' },
    });
    fireEvent.click(screen.getByRole('button', { name: '填写退货物流' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/aftersale/return-shipment/index?id=601' },
    });
  });

  it('goes back to the 订单详情 it was opened from for 查看订单, not to a second copy', async () => {
    serveApi({ 'GET /api/v1/refunds/601': () => ({ body: awaitingReturn }) });
    taroFake.pageStack = [
      { route: 'packages/order/detail/index', options: { id: '9001' } },
      { route: 'packages/aftersale/detail/index', options: { id: '601' } },
    ];
    await renderPage(<RefundDetailPage />);
    fireEvent.click(await screen.findByRole('link', { name: '查看订单' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({ api: 'navigateBack', args: { delta: 1 } }),
    );
    expect(taroFake.calls.some((call) => call.api === 'navigateTo')).toBe(false);
  });

  it('opens 订单详情 in its place from 售后列表 for 查看订单', async () => {
    serveApi({ 'GET /api/v1/refunds/601': () => ({ body: awaitingReturn }) });
    taroFake.pageStack = [
      { route: 'packages/aftersale/list/index', options: {} },
      { route: 'packages/aftersale/detail/index', options: { id: '601' } },
    ];
    await renderPage(<RefundDetailPage />);
    fireEvent.click(await screen.findByRole('link', { name: '查看订单' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/order/detail/index?id=9001' },
      }),
    );
  });

  it('withdraws a request from the bar and shows it withdrawn', async () => {
    let status: 'applied' | 'cancelled' = 'applied';
    const seen = serveApi({
      'GET /api/v1/refunds/601': () => ({ body: refundDetail({ status }) }),
      'POST /api/v1/refunds/601/cancel': () => {
        status = 'cancelled';
        return { body: refundDetail({ status }) };
      },
    });
    await renderPage(<RefundDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: '撤销申请' }));
    await screen.findByText('已撤销');
    expect(seen.map((r) => r.key)).toContain('POST /api/v1/refunds/601/cancel');
  });

  it('gives the reason for a refusal', async () => {
    serveApi({
      'GET /api/v1/refunds/601': () => ({
        body: refundDetail({ status: 'rejected', rejectReason: '商品已使用' }),
      }),
    });
    await renderPage(<RefundDetailPage />);
    await screen.findByText('原因：商品已使用');
    await waitFor(() => expect(screen.getByRole('button', { name: '删除记录' })).toBeTruthy());
  });
});
