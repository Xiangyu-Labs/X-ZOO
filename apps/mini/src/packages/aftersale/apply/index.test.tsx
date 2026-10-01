import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSubscribeTemplates } from '@/platform';
import { useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { refundableItem, refundableItems, refundDetail } from '@/test/order-fixtures';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import RefundApplyPage, { includesFreight } from './index';

const reasons = { items: ['不想要了', '商品与描述不符'] };

function serve(data = refundableItems()) {
  return serveApi({
    'GET /api/v1/refunds/applicable-items/9001': () => ({ body: data }),
    'GET /api/v1/refund-reasons': () => ({ body: reasons }),
    'POST /api/v1/refunds': () => ({ status: 201, body: refundDetail({ id: '601' }) }),
  });
}

async function chooseReason(reason: string) {
  fireEvent.click(screen.getByRole('link', { name: '选择售后原因' }));
  fireEvent.click(await screen.findByRole('radio', { name: reason }));
}

describe('申请售后', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'signed-in', token: 't' } });
    taroFake.routerParams = { orderId: '9001' };
  });
  afterEach(() => setSubscribeTemplates({}));

  it('refunds a whole unshipped order with its freight, asking for notices first', async () => {
    setSubscribeTemplates({ refundApply: ['tpl-refund'] });
    const seen = serve();
    await renderPage(<RefundApplyPage />);
    await screen.findByText('商品 7001');
    // Nothing shipped: 仅退款 only, and the estimate includes the freight.
    expect(screen.queryByRole('radio', { name: '退货退款' })).toBeNull();
    expect(screen.getByLabelText('价格 68 元')).toBeTruthy();
    expect(screen.getByText('含运费，最终以商家审核为准')).toBeTruthy();

    await chooseReason('不想要了');
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/aftersale/detail/index?id=601' },
      }),
    );
    expect(seen.find((r) => r.key === 'POST /api/v1/refunds')?.body).toEqual({
      orderId: '9001',
      kind: 'refund_only',
      lines: [{ orderItemId: '7001', quantity: 2 }],
      reason: '不想要了',
      images: [],
      includeFreight: true,
    });
    const apis = taroFake.calls.map((c) => c.api);
    const subscribed = apis.indexOf('requestSubscribeMessage');
    const posted = taroFake.calls.findIndex(
      (c) => c.api === 'request' && (c.args as { method: string }).method === 'POST',
    );
    expect(subscribed).toBeGreaterThanOrEqual(0);
    expect(subscribed).toBeLessThan(posted);
  });

  it('offers 退货退款 for shipped goods, and fewer units without the freight', async () => {
    const seen = serve(
      refundableItems({
        freightRefundable: false,
        items: [
          refundableItem('7001', {
            shippedQuantity: 2,
            refundableQuantity: 2,
            refundableAmount: '60.00',
          }),
        ],
      }),
    );
    await renderPage(<RefundApplyPage />);
    await screen.findByText('商品 7001');
    expect(screen.getByRole('radio', { name: '退货退款' }).getAttribute('aria-checked')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: '减少售后数量' }));
    expect(screen.getByLabelText('价格 30 元')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明' }), {
      target: { value: '包装破损' },
    });
    await chooseReason('商品与描述不符');
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() => expect(seen.map((r) => r.key)).toContain('POST /api/v1/refunds'));
    expect(seen.find((r) => r.key === 'POST /api/v1/refunds')?.body).toMatchObject({
      kind: 'return_and_refund',
      lines: [{ orderItemId: '7001', quantity: 1 }],
      explanation: '包装破损',
      includeFreight: false,
    });
  });

  it('needs a line and a reason before it sends anything', async () => {
    const seen = serve();
    await renderPage(<RefundApplyPage />);
    await screen.findByText('商品 7001');
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '请选择售后原因' }),
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 商品 7001' }));
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    expect(taroFake.calls).toContainEqual({
      api: 'showToast',
      args: expect.objectContaining({ title: '请选择要售后的商品' }),
    });
    expect(seen.some((r) => r.key === 'POST /api/v1/refunds')).toBe(false);
  });

  it('greys out a line already in after-sales and says why', async () => {
    serve(
      refundableItems({
        items: [
          refundableItem('7001'),
          refundableItem('7002', { blockedReason: 'REFUND_ALREADY_OPEN', refundableQuantity: 0 }),
        ],
      }),
    );
    await renderPage(<RefundApplyPage />);
    await screen.findByText('已有售后处理中');
    expect(
      screen.getByRole('checkbox', { name: '选择 商品 7002' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it("shows the server's refusal and stays on the form", async () => {
    serveApi({
      'GET /api/v1/refunds/applicable-items/9001': () => ({ body: refundableItems() }),
      'GET /api/v1/refund-reasons': () => ({ body: reasons }),
      'POST /api/v1/refunds': () => ({
        status: 409,
        body: { code: 'REFUND_ALREADY_OPEN', message: '该商品已有正在处理的售后申请' },
      }),
    });
    await renderPage(<RefundApplyPage />);
    await screen.findByText('商品 7001');
    await chooseReason('不想要了');
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '该商品已有正在处理的售后申请' }),
      }),
    );
    expect(taroFake.calls.some((c) => c.api === 'redirectTo')).toBe(false);
  });

  it('REFUND-018 — sends the freight with the rest of an unshipped order when the other line is already in after-sales', () => {
    const data = refundableItems({
      items: [
        refundableItem('7001'),
        refundableItem('7002', { blockedReason: 'REFUND_ALREADY_OPEN', refundableQuantity: 0 }),
      ],
    });
    expect(includesFreight(data, { '7001': 2 })).toBe(true);
    expect(includesFreight(data, { '7001': 1 })).toBe(false);
    expect(includesFreight({ ...data, freightRefundable: false }, { '7001': 2 })).toBe(false);
  });
});
