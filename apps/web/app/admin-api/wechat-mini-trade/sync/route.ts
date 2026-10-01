import { paymentMiniTradeSync } from '@shop/contracts/payment/payment.mini-trade.contract';
import { syncMiniTrade } from '@shop/core/payment';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/wechat-mini-trade/sync` — 同步: asks WeChat whether the mini
 * program is under 发货信息管理, and sets where its messages open. An operator's
 * button, not a side effect of saving a form: WeChat's answer is for them to read.
 */
export const POST = handle(paymentMiniTradeSync, async (ctx) => {
  const result = await syncMiniTrade(ctx);
  ctx.audit('wechat-mini-trade:sync');
  return result;
});

export const dynamic = 'force-dynamic';
