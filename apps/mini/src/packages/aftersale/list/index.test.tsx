import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { paged, refundDetail, refundListItem } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import RefundListPage from './index';

function requestedStates(): string[] {
  return taroFake.calls
    .filter((call) => call.api === 'request')
    .map((call) => (call.args as { url: string }).url)
    .filter((url) => /\/api\/v1\/refunds\?/.test(url))
    .map((url) => new URL(url, 'https://x').searchParams.get('state') ?? '');
}

describe('我的售后', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists refunds and returns together, by state', async () => {
    taroFake.routerParams = { state: 'open' };
    serveApi({
      'GET /api/v1/refunds': () => ({
        body: paged([
          refundListItem({ id: '1', refundNo: 'RF1' }),
          refundListItem({
            id: '2',
            refundNo: 'RF2',
            kind: 'return_and_refund',
            status: 'approved',
            returnStage: 'awaiting_shipment',
          }),
        ]),
      }),
    });
    await renderPage(<RefundListPage />);
    await screen.findByText('售后单号 RF1');
    expect(screen.getByText('待商家处理')).toBeTruthy();
    expect(screen.getByText('待寄回商品')).toBeTruthy();
    expect(requestedStates()).toEqual(['open']);

    fireEvent.click(screen.getByRole('button', { name: '填写退货物流' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/aftersale/return-shipment/index?id=2' },
    });

    fireEvent.click(screen.getByRole('tab', { name: '已关闭' }));
    await waitFor(() => expect(requestedStates()).toEqual(['open', 'closed']));
  });

  it('coming back to a stale list, asks for page 1 only and keeps the pages scrolled through', async () => {
    let round = 0;
    const seen = serveApi({
      'GET /api/v1/refunds': () => {
        const page = Number(seen.at(-1)?.query.page);
        if (page === 1) round += 1;
        const ids = page === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [11];
        const items = ids.map((n) =>
          refundListItem({ id: String(n), refundNo: n === 1 ? `R${round}-RF1` : `RF${n}` }),
        );
        return { body: paged(items, 11, page) };
      },
    });
    await renderPage(<RefundListPage />);
    await screen.findByText('售后单号 R1-RF1');
    taroFake.reachBottom();
    await screen.findByText('售后单号 RF11');

    // Back from another page after the 30 s staleTime (the test client's is 0).
    taroFake.showPage();
    await screen.findByText('售后单号 R2-RF1');
    expect(seen.map((r) => r.query.page)).toEqual(['1', '2', '1']);
    expect(screen.getByText('售后单号 RF11')).toBeTruthy();
  });

  it('coming back after 5 minutes away, reloads every page from page 1', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let round = 0;
    const seen = serveApi({
      'GET /api/v1/refunds': () => {
        const page = Number(seen.at(-1)?.query.page);
        if (page === 1) round += 1;
        const ids = page === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [11];
        const items = ids.map((n) =>
          refundListItem({
            id: String(n),
            refundNo: n === 1 || n === 11 ? `R${round}-RF${n}` : `RF${n}`,
          }),
        );
        return { body: paged(items, 11, page) };
      },
    });
    await renderPage(<RefundListPage />);
    await screen.findByText('售后单号 R1-RF1');
    taroFake.reachBottom();
    await screen.findByText('售后单号 R1-RF11');

    taroFake.hidePage();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    taroFake.showPage();
    await screen.findByText('售后单号 R2-RF11');
    expect(seen.map((r) => r.query.page)).toEqual(['1', '2', '1', '2']);
    expect(screen.getByText('售后单号 R2-RF1')).toBeTruthy();
  });

  it('withdraws a request after asking', async () => {
    const seen = serveApi({
      'GET /api/v1/refunds': () => ({ body: paged([refundListItem()]) }),
      'POST /api/v1/refunds/601/cancel': () => ({ body: refundDetail({ status: 'cancelled' }) }),
    });
    await renderPage(<RefundListPage />);
    fireEvent.click(await screen.findByRole('button', { name: '撤销申请' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/refunds/601/cancel'),
    );
  });

  it('deletes a finished record', async () => {
    const seen = serveApi({
      'GET /api/v1/refunds': () => ({ body: paged([refundListItem({ status: 'succeeded' })]) }),
      'DELETE /api/v1/refunds/601': () => ({ body: { deleted: true } }),
    });
    await renderPage(<RefundListPage />);
    expect(await screen.findByText('退款成功')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '撤销申请' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }));
    await waitFor(() => expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/refunds/601'));
  });

  it('says when there is nothing', async () => {
    serveApi({ 'GET /api/v1/refunds': () => ({ body: paged([]) }) });
    await renderPage(<RefundListPage />);
    await screen.findByText('没有售后记录');
  });
});
