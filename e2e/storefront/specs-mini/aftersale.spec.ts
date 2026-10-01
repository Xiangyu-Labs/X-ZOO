import { miniRoute, test, expect } from '../src/mini';
import { openFresh, shown } from '../src/mini-pages/shown';
import {
  RefundApplyPage,
  RefundDetailPage,
  RefundListPage,
  ReturnShipmentPage,
} from '../src/mini-pages/aftersale-pages';
import { OrderDetailPage } from '../src/mini-pages/order-pages';
import {
  arrangeMiniPaidOrder,
  shipByExpress,
  signUpFromOrders,
} from '../src/mini-pages/order-shopper';

/**
 * The mini-program's after-sales pages, end to end (stream C): a shopper asks
 * for their money back on an order not yet shipped, the merchant approves it
 * and the page follows it to 退款成功; and a shopper returning shipped goods
 * sends back the waybill of the parcel.
 *
 * The order is paid in the app (a `wechat_mini` payment) and shipped through
 * the domain service; approving is the admin API's. A `refund_only` approval
 * goes straight to the fake gateway, which `scripts/serve.ts` settles
 * synchronously.
 */

test('a shopper applies for a refund, the merchant approves, the page follows it', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  const order = await arrangeMiniPaidOrder(page, shopper, shop);

  // 订单详情's 申请售后, next to the lines.
  const orderPage = new OrderDetailPage(page);
  await orderPage.open(order.id);
  await orderPage.aftersale().click();
  const apply = new RefundApplyPage(page);
  await apply.expectOpen();
  // Nothing shipped: 仅退款 is the only kind, and the freight goes back too.
  await expect(apply.kind('退货退款')).toHaveCount(0);
  await expect(shown(page).getByText('含运费，最终以商家审核为准')).toBeVisible();
  await apply.chooseReason('不想要了');
  await apply.explain('拍错了规格');

  const applied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/refunds' &&
      response.request().method() === 'POST',
  );
  await apply.submit();
  const refund = (await (await applied).json()) as {
    id: string;
    refundNo: string;
    kind: string;
    amount: string;
  };
  expect(refund).toMatchObject({ kind: 'refund_only', amount: '45.00' });

  // 售后详情 replaces the form.
  await expect(page).toHaveURL(new RegExp(`packages/aftersale/detail/index\\?id=${refund.id}`));
  const detail = new RefundDetailPage(page);
  await detail.expectStatus('待商家处理');
  await expect(detail.action('撤销申请')).toBeVisible();

  const approve = await adminApi.post(`/admin-api/refunds/${refund.id}/approve`, {
    data: { remark: 'E2E: 同意退款' },
  });
  expect(approve.ok(), `approve failed: ${approve.status()} ${await approve.text()}`).toBe(true);
  await expect(async () => {
    const response = await shopper.api.get(`/api/v1/refunds/${refund.id}`);
    expect(((await response.json()) as { status: string }).status).toBe('succeeded');
  }).toPass({ timeout: 20_000 });

  await detail.open(refund.id);
  await detail.expectStatus('退款成功');
  await expect(detail.steps().first()).toContainText('退款成功');
  await expect(detail.action('撤销申请')).toHaveCount(0);

  // 我的售后 files it under 已退款; the order says it was refunded.
  const list = new RefundListPage(page);
  await list.open();
  await list.tab('已退款').click();
  await expect(list.card(refund.refundNo)).toContainText('退款成功');
  await orderPage.open(order.id);
  await orderPage.expectHeadline('已退款');

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('a shopper returning shipped goods fills in the return waybill', async ({
  miniPage: page,
  wechatUser,
  shop,
  playwright,
  adminApi,
  consoleErrors,
  failedRequests,
}) => {
  const shopper = await signUpFromOrders(page, wechatUser, shop, playwright);
  const order = await arrangeMiniPaidOrder(page, shopper, shop);
  await shipByExpress(adminApi, shop, order.id);

  // 退货退款 on the shipped line, through the apply page.
  await openFresh(page, miniRoute('packages/aftersale/apply/index', { orderId: order.id }));
  const apply = new RefundApplyPage(page);
  await apply.expectOpen();
  await apply.kind('退货退款').click();
  await apply.chooseReason('与描述不符');
  const applied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/refunds' &&
      response.request().method() === 'POST',
  );
  await apply.submit();
  const refund = (await (await applied).json()) as { id: string; kind: string };
  expect(refund.kind).toBe('return_and_refund');

  const approve = await adminApi.post(`/admin-api/refunds/${refund.id}/approve`, {
    data: {
      remark: 'E2E: 同意退货',
      returnAddress: {
        name: '售后仓',
        phone: '02088888888',
        address: '广东省广州市天河区售后路 1 号',
      },
    },
  });
  expect(approve.ok(), `approve failed: ${approve.status()} ${await approve.text()}`).toBe(true);

  const detail = new RefundDetailPage(page);
  await detail.open(refund.id);
  await detail.expectStatus('待寄回商品');
  await expect(shown(page).getByText('广东省广州市天河区售后路 1 号').first()).toBeVisible();
  await detail.action('填写退货物流').click();

  const form = new ReturnShipmentPage(page);
  await form.expectOpen();
  await form.chooseCompany('顺丰', '顺丰速运');
  await form.fill('sf 1122 3344 55', wechatUser.phone);
  await form.submit();

  // Back on 售后详情, which now waits for the merchant to receive it.
  await expect(page).toHaveURL(new RegExp(`packages/aftersale/detail/index\\?id=${refund.id}`));
  await detail.expectStatus('待商家收货');
  await expect(shown(page).getByText('顺丰速运 SF1122334455', { exact: true })).toBeVisible();

  const response = await shopper.api.get(`/api/v1/refunds/${refund.id}`);
  const stored = (await response.json()) as {
    returnStage: string;
    returnExpressCompanyName: string | null;
    returnTrackingNo: string | null;
    returnPhone: string | null;
  };
  expect(stored).toMatchObject({
    returnStage: 'shipped_back',
    returnExpressCompanyName: '顺丰速运',
    returnTrackingNo: 'SF1122334455',
    returnPhone: wechatUser.phone,
  });

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
