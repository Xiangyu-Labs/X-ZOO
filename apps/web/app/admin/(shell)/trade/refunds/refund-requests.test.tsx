import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  refundAdminApprove,
  refundAdminDetail,
  refundAdminList,
  refundAdminReject,
  refundAdminRetry,
  refundAdminWithdraw,
} from '@shop/contracts/refund/refund.admin.contract';
import {
  adminRefundDetailExample,
  adminRefundExample,
  type AdminRefundListItem,
} from '@shop/contracts/refund/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { RefundRequestsPage } from './refund-requests';

/**
 * 售后单 as a component test: an operator decides from the dialog, so the
 * dialog must carry what is being decided — the amount and the buyer's reason —
 * and the drawer next to it must not keep the status from before the click.
 */

const identity = {
  ...testIdentity,
  permissions: ['refund:request:read', 'refund:request:review', 'refund:request:execute'],
};

function stubApi(row: AdminRefundListItem = adminRefundExample): StubCall[] {
  return stubRoutes([
    on(refundAdminList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(refundAdminDetail, { ...adminRefundDetailExample, ...row }),
    on(refundAdminApprove, { ...adminRefundDetailExample, ...row, status: 'approved' }),
    on(refundAdminReject, {
      ...adminRefundDetailExample,
      ...row,
      status: 'rejected',
      rejectReason: '已线下退款',
    }),
    on(refundAdminWithdraw, { ...adminRefundDetailExample, ...row, status: 'cancelled' }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

describe('售后单', () => {
  for (const action of ['同意', '拒绝'] as const) {
    it(`repeats the amount and the buyer’s reason in the ${action} dialog`, async () => {
      stubApi();
      renderAdmin(<RefundRequestsPage />, { identity });
      await screen.findByText(adminRefundExample.refundNo);

      await userEvent.click(screen.getByRole('button', { name: action }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('买家原因')).toBeInTheDocument();
      expect(within(dialog).getByText('商品破损')).toBeInTheDocument();
      expect(within(dialog).getByText('申请金额')).toBeInTheDocument();
    });
  }

  it('shows the internal 备注 in the list, and — where there is none', async () => {
    stubRoutes([
      on(refundAdminList, {
        items: [
          { ...adminRefundExample, id: '1', refundNo: 'RF0001', adminRemark: '已电话联系买家' },
          { ...adminRefundExample, id: '2', refundNo: 'RF0002', adminRemark: null },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      }),
    ]);
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText('RF0001');

    const column = screen.getAllByRole('columnheader').findIndex((th) => th.textContent === '备注');
    expect(column).toBeGreaterThan(-1);
    const cellOf = (refundNo: string) =>
      screen.getByText(refundNo).closest('tr')!.querySelectorAll('td')[column];
    expect(cellOf('RF0001')).toHaveTextContent('已电话联系买家');
    expect(cellOf('RF0002')).toHaveTextContent('—');
  });

  it('REFUND-017 — offers 关闭 on a refund WeChat refused, through the reject route', async () => {
    const failed: AdminRefundListItem = {
      ...adminRefundExample,
      kind: 'refund_only',
      returnStage: 'not_required',
      status: 'failed',
      lastError: 'refused NOT_ENOUGH: 余额不足',
      lastErrorSummary: '微信支付商户号余额不足，请到商户平台充值后重试',
    };
    const calls = stubApi(failed);
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(failed.refundNo);

    expect(screen.queryByRole('button', { name: '同意' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), '已线下退款');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认关闭' }));

    await waitFor(() => {
      const reject = calls.find((call) => call.method === 'POST');
      expect(reject?.url).toContain(`/admin-api/refunds/${failed.id}/reject`);
      expect(reject?.body).toEqual({ rejectReason: '已线下退款' });
    });
  });

  it('says a 重试 that WeChat refused again was refused, with the reason, not 已重新处理', async () => {
    const failed: AdminRefundListItem = {
      ...adminRefundExample,
      kind: 'refund_only',
      returnStage: 'not_required',
      status: 'failed',
      lastError: 'refused NOT_ENOUGH: 余额不足',
      lastErrorSummary: '微信支付商户号余额不足，请到商户平台充值后重试',
    };
    stubRoutes([
      on(refundAdminList, { items: [failed], total: 1, page: 1, pageSize: 20 }),
      on(refundAdminDetail, { ...adminRefundDetailExample, ...failed }),
      on(refundAdminRetry, { ...adminRefundDetailExample, ...failed }),
    ]);
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(failed.refundNo);

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    const ask = await screen.findByText('重新处理这笔退款？');
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: /确\s*定/ }));

    expect(
      await screen.findByText(`退款没有成功：${failed.lastErrorSummary}`, {
        selector: '.ant-message *',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('已重新处理')).not.toBeInTheDocument();
  });

  it('tells staff why in Chinese and keeps the gateway’s words under 技术详情', async () => {
    const failed: AdminRefundListItem = {
      ...adminRefundExample,
      kind: 'refund_only',
      returnStage: 'not_required',
      status: 'failed',
      lastError: 'refused NOT_ENOUGH: 余额不足',
      lastErrorSummary: '微信支付商户号余额不足，请到商户平台充值后重试',
    };
    stubApi(failed);
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(failed.refundNo);

    expect(screen.getByText(failed.lastErrorSummary!)).toBeInTheDocument();
    expect(screen.queryByText(/NOT_ENOUGH/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(failed.lastErrorSummary!)).toBeInTheDocument();
    expect(within(drawer).queryByText(/NOT_ENOUGH/)).not.toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: '技术详情' }));
    expect(await screen.findByText('refused NOT_ENOUGH: 余额不足')).toBeInTheDocument();
  });

  it('shows the address this return was sent to in the drawer', async () => {
    const approved: AdminRefundListItem = { ...adminRefundExample, status: 'approved' };
    stubRoutes([
      on(refundAdminList, { items: [approved], total: 1, page: 1, pageSize: 20 }),
      on(refundAdminDetail, {
        ...adminRefundDetailExample,
        ...approved,
        returnAddress: { name: '售后部', phone: '02000000000', address: '广州市天河区某路 1 号' },
      }),
    ]);
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(approved.refundNo);

    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(await screen.findByText('售后部 02000000000 广州市天河区某路 1 号')).toBeInTheDocument();
  });

  it('shows the buyer’s photos in the drawer and decides from its foot', async () => {
    stubApi();
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(adminRefundExample.refundNo);

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: '详情' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('凭证图片');
    const photos = [...drawer.querySelectorAll('img')].filter(
      (img) => img.getAttribute('src') === adminRefundDetailExample.images[0],
    );
    expect(photos).toHaveLength(1);
    expect(within(drawer).getByRole('link', { name: adminRefundExample.orderNo })).toHaveAttribute(
      'href',
      `/admin/orders/${adminRefundExample.orderId}`,
    );

    const footer = drawer.querySelector('.ant-drawer-footer') as HTMLElement;
    await user.click(within(footer).getByRole('button', { name: zhName('同意') }));
    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs.some((dialog) => within(dialog).queryByText('确认同意') !== null)).toBe(true);
  });

  it('offers no address of its own to a reviewer who may not change 售后设置', async () => {
    stubApi();
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(adminRefundExample.refundNo);

    await userEvent.click(screen.getByRole('button', { name: '同意' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('收件人')).not.toBeInTheDocument();
  });

  describe('sending one return elsewhere (refund:config:write)', () => {
    const owner = { ...identity, permissions: [...identity.permissions, 'refund:config:write'] };

    async function openApprove() {
      const calls = stubApi();
      renderAdmin(<RefundRequestsPage />, { identity: owner });
      await screen.findByText(adminRefundExample.refundNo);
      await userEvent.click(screen.getByRole('button', { name: '同意' }));
      return { calls, dialog: await screen.findByRole('dialog') };
    }

    it('sends the address typed in the dialog', async () => {
      const { calls, dialog } = await openApprove();
      await userEvent.type(within(dialog).getByLabelText('收件人'), '二号仓');
      await userEvent.type(within(dialog).getByLabelText('联系电话'), '13900000000');
      await userEvent.type(within(dialog).getByLabelText('退货地址'), '江苏省南京市雨花台区 2 号');
      await userEvent.click(within(dialog).getByRole('button', { name: '确认同意' }));

      await waitFor(() => {
        const approve = calls.find((call) => call.method === 'POST');
        expect(approve?.body).toEqual({
          returnAddress: {
            name: '二号仓',
            phone: '13900000000',
            address: '江苏省南京市雨花台区 2 号',
          },
        });
      });
    });

    it('sends no address when all three are left blank', async () => {
      const { calls, dialog } = await openApprove();
      await userEvent.click(within(dialog).getByRole('button', { name: '确认同意' }));

      await waitFor(() => {
        const approve = calls.find((call) => call.method === 'POST');
        expect(approve?.body).toEqual({});
      });
    });

    it('asks for the rest when only part of the address is typed', async () => {
      const { calls, dialog } = await openApprove();
      await userEvent.type(within(dialog).getByLabelText('收件人'), '二号仓');
      await userEvent.click(within(dialog).getByRole('button', { name: '确认同意' }));

      expect(await within(dialog).findByText('请填写联系电话')).toBeInTheDocument();
      expect(within(dialog).getByText('请填写退货地址')).toBeInTheDocument();
      expect(calls.some((call) => call.method === 'POST')).toBe(false);
    });
  });

  it('refreshes the open drawer after an approval', async () => {
    const calls = stubApi();
    renderAdmin(<RefundRequestsPage />, { identity });
    await screen.findByText(adminRefundExample.refundNo);

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: '详情' }));
    await screen.findByText('收到时箱子被压坏，里面有三个苹果烂了');
    const detailCalls = () =>
      calls.filter(
        (call) =>
          call.method === 'GET' && call.url.includes(`/admin-api/refunds/${adminRefundExample.id}`),
      ).length;
    const before = detailCalls();

    await user.click(screen.getByRole('button', { name: '同意' }));
    const dialogs = await screen.findAllByRole('dialog');
    const approve = dialogs.find((dialog) => within(dialog).queryByText('确认同意') !== null)!;
    await user.click(within(approve).getByRole('button', { name: '确认同意' }));

    await waitFor(() => expect(detailCalls()).toBeGreaterThan(before));
  });

  describe('商家发起的售后', () => {
    const opened: AdminRefundListItem = {
      ...adminRefundExample,
      status: 'approved',
      returnStage: 'awaiting_shipment',
      reason: '质量问题',
      initiatedByAdminId: '1',
      initiatedByAdminName: '店长',
    };

    it('is tagged 商家 and offers 撤销 while the goods have not been sent', async () => {
      const calls = stubApi(opened);
      renderAdmin(<RefundRequestsPage />, { identity });
      await screen.findByText(opened.refundNo);
      expect(screen.getByText('商家')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: '撤销' }));
      const dialog = await screen.findByRole('dialog');
      // Its reason is the shop's, not the buyer's.
      expect(within(dialog).getByText('售后原因')).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: zhName('确认撤销') }));
      expect(await within(dialog).findByText('请填写撤销原因')).toBeInTheDocument();

      await userEvent.type(within(dialog).getByLabelText('撤销原因'), '已与买家协商');
      await userEvent.click(within(dialog).getByRole('button', { name: zhName('确认撤销') }));
      await waitFor(() => {
        const post = calls.find((call) => call.routeId === refundAdminWithdraw.id);
        expect(post?.params).toEqual({ id: opened.id });
        expect(post?.body).toEqual({ reason: '已与买家协商' });
      });
    });

    it('offers no 撤销 on a buyer’s own request, nor once the goods are on their way', async () => {
      for (const row of [
        { ...opened, initiatedByAdminId: null, initiatedByAdminName: null },
        { ...opened, returnStage: 'shipped_back' as const },
      ]) {
        stubApi(row);
        const { unmount } = renderAdmin(<RefundRequestsPage />, { identity });
        await screen.findByText(row.refundNo);
        expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
        unmount();
      }
    });
  });
});
