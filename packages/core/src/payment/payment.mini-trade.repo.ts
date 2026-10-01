import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '@shop/db';
import { wechatTradeOrders, type WechatTradeOrder } from '@shop/db/schema/payment';
import { conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * `wechat_trade_orders`: WeChat's view of a mini-program payment — what was
 * reported, when the buyer confirmed, when the money settled. Every write is
 * idempotent (a `coalesce`, or a conditional update on a still-empty column),
 * because every caller is an at-least-once effect.
 */

export type TradeOrderRow = WechatTradeOrder;

export async function ensureTradeOrder(
  db: DbOrTx,
  values: {
    orderId: number;
    paymentAttemptId: number;
    mchId: string;
    outTradeNo: string;
    transactionId: string;
  },
): Promise<TradeOrderRow> {
  await db.insert(wechatTradeOrders).values(values).onConflictDoNothing();
  const row = await findTradeOrderByOrder(db, values.orderId);
  if (!row) throw new Error(`wechat_trade_orders: 订单 ${values.orderId} 未写入`);
  return row;
}

export async function findTradeOrderByOrder(
  db: DbOrTx,
  orderId: number,
): Promise<TradeOrderRow | null> {
  const rows = await db
    .select()
    .from(wechatTradeOrders)
    .where(eq(wechatTradeOrders.orderId, orderId))
    .limit(1);
  return rows[0] ?? null;
}

/** The push names the payment: `merchant_trade_no` first, `transaction_id` as the fallback. */
export async function findTradeOrderByPayment(
  db: DbOrTx,
  args: { outTradeNo: string; transactionId: string },
): Promise<TradeOrderRow | null> {
  if (args.outTradeNo !== '') {
    const rows = await db
      .select()
      .from(wechatTradeOrders)
      .where(eq(wechatTradeOrders.outTradeNo, args.outTradeNo))
      .limit(1);
    if (rows[0]) return rows[0];
  }
  if (args.transactionId === '') return null;
  const rows = await db
    .select()
    .from(wechatTradeOrders)
    .where(eq(wechatTradeOrders.transactionId, args.transactionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markUploaded(
  db: DbOrTx,
  args: { orderId: number; at: Date; allDelivered: boolean },
): Promise<void> {
  await db
    .update(wechatTradeOrders)
    .set({
      uploadedAt: sql`coalesce(${wechatTradeOrders.uploadedAt}, ${args.at})`,
      ...(args.allDelivered
        ? { allDeliveredAt: sql`coalesce(${wechatTradeOrders.allDeliveredAt}, ${args.at})` }
        : {}),
      updatedAt: args.at,
    })
    .where(eq(wechatTradeOrders.orderId, args.orderId));
}

/** WeChat allows one correction; the first caller to stamp it has spent it. */
export async function claimCorrection(
  db: DbOrTx,
  args: { orderId: number; at: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatTradeOrders, {
    where: and(eq(wechatTradeOrders.orderId, args.orderId), isNull(wechatTradeOrders.correctedAt)),
    set: { correctedAt: args.at, updatedAt: args.at },
  });
}

/** First confirmation wins; a later push or component callback leaves it be. */
export async function markConfirmed(
  db: DbOrTx,
  args: { orderId: number; at: Date; source: 'manual' | 'auto' | 'component'; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, wechatTradeOrders, {
    where: and(eq(wechatTradeOrders.orderId, args.orderId), isNull(wechatTradeOrders.confirmedAt)),
    set: { confirmedAt: args.at, confirmSource: args.source, updatedAt: args.now },
  });
}

export async function markSettled(
  db: DbOrTx,
  args: { orderId: number; at: Date; now: Date },
): Promise<void> {
  await db
    .update(wechatTradeOrders)
    .set({
      settledAt: sql`coalesce(${wechatTradeOrders.settledAt}, ${args.at})`,
      updatedAt: args.now,
    })
    .where(eq(wechatTradeOrders.orderId, args.orderId));
}
