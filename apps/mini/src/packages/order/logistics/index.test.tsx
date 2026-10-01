import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { shipment, tracking } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import LogisticsPage from './index';

describe('物流信息', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    taroFake.routerParams = { orderId: '9001' };
  });

  it("shows the courier's trail, newest first, and copies the number", async () => {
    serveApi({
      'GET /api/v1/orders/9001/shipments': () => ({ body: { items: [shipment('4001')] } }),
      'GET /api/v1/shipments/4001/tracking': () => ({ body: tracking('4001') }),
    });
    await renderPage(<LogisticsPage />);

    await screen.findByText('快件已从转运中心发出');
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]?.textContent).toContain('快件已从转运中心发出');
    expect(screen.getByText('运单号 SF4001')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '复制运单号' }));
    expect(taroFake.calls).toContainEqual({ api: 'setClipboardData', args: { data: 'SF4001' } });
  });

  it('has a tab per parcel of a split shipment', async () => {
    const seen = serveApi({
      'GET /api/v1/orders/9001/shipments': () => ({
        body: { items: [shipment('4001'), shipment('4002', { expressCompanyName: '中通快递' })] },
      }),
      'GET /api/v1/shipments/4001/tracking': () => ({ body: tracking('4001') }),
      'GET /api/v1/shipments/4002/tracking': () => ({
        body: tracking('4002', { available: false, traces: [], state: 'unknown' }),
      }),
    });
    await renderPage(<LogisticsPage />);
    await screen.findByRole('tab', { name: '包裹1' });

    fireEvent.click(screen.getByRole('tab', { name: '包裹2' }));
    await screen.findByText('中通快递');
    await screen.findByText(/暂无物流轨迹/);
    expect(seen.map((r) => r.key)).toContain('GET /api/v1/shipments/4002/tracking');
  });

  it('opens on the parcel it was sent to', async () => {
    taroFake.routerParams = { orderId: '9001', shipmentId: '4002' };
    const seen = serveApi({
      'GET /api/v1/orders/9001/shipments': () => ({
        body: { items: [shipment('4001'), shipment('4002')] },
      }),
      'GET /api/v1/shipments/4002/tracking': () => ({ body: tracking('4002') }),
    });
    await renderPage(<LogisticsPage />);
    await screen.findByText('运单号 SF4002');
    expect(seen.map((r) => r.key)).not.toContain('GET /api/v1/shipments/4001/tracking');
  });

  it('says so before anything shipped', async () => {
    serveApi({ 'GET /api/v1/orders/9001/shipments': () => ({ body: { items: [] } }) });
    await renderPage(<LogisticsPage />);
    await screen.findByText('还没有发货');
  });
});
