import { paymentWechatReceipt } from '@shop/contracts/payment/payment.mini-trade.contract';
import { wechatReceipt } from '@shop/core/payment';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/orders/:id/wechat-receipt` — what the mini program hands WeChat's
 * 确认收货 component (`wx.openBusinessView({ businessType: 'weappOrderConfirm' })`).
 *
 * Only for the signed-in shopper's own order (a stranger's is `ORDER_NOT_FOUND`),
 * and only once the order is shipped and WeChat was told everything left;
 * otherwise `{ receipt: null }` and the client uses the ordinary button.
 */
export const GET = handle(paymentWechatReceipt, (ctx, { params }) => wechatReceipt(ctx, params));

export const dynamic = 'force-dynamic';
