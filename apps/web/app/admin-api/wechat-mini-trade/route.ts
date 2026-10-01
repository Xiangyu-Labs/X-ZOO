import { paymentMiniTradeStatus } from '@shop/contracts/payment/payment.mini-trade.contract';
import { miniTradeStatus } from '@shop/core/payment';
import { handle } from '../../../src/server';

/** `/admin-api/wechat-mini-trade` — 小程序发货信息管理: what WeChat was last told. */
export const GET = handle(paymentMiniTradeStatus, (ctx) => miniTradeStatus(ctx));

export const dynamic = 'force-dynamic';
