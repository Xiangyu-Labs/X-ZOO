import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import { SummarizedError } from '../kernel/error-summary';
import { registerEffectHandler, type Effect } from '../effects/index';
import { formatShopTime, notify } from '../notification';
import { autoDeliver } from '../order';
import { refundSystemInitiated } from '../refund';
import { settleGroup } from './groupbuy.jobs';
import { GROUPBUY_EVENTS, refundNoteOf } from './groupbuy.notifications';
import * as repo from './groupbuy.repo';

/**
 * What the group-buy domain does *after* the transaction commits.
 *
 * Anything that calls a third party happens after commit, via the effects
 * ledger — never inside the transaction. A notification sent inside it would
 * let a WeChat timeout roll back a team that had genuinely completed, so there
 * is no flag to opt in: every notification is an effect, always.
 *
 * Four event types, recorded in `groupbuy.order.ts` and `groupbuy.jobs.ts` —
 * and `groupbuy.settle` also by 立即成团 (`groupbuy.service.ts`):
 *
 * | scope      | event_type         | when                                        |
 * | ---------- | ------------------ | ------------------------------------------- |
 * | `order`    | `groupbuy.join`    | a paid order took a seat                    |
 * | `groupbuy` | `groupbuy.settle`  | a team succeeded or failed                  |
 * | `order`    | `groupbuy.refund`  | the shop owes money nobody asked it for     |
 * | `groupbuy` | `groupbuy.expire`  | a team's clock ran out (delayed)            |
 *
 * The first three are also where the shopper hears about it — see
 * `groupbuy.notifications.ts` for which message each one sends.
 *
 * `groupbuy.expire` is the timer, and it is an effect rather than a delayed
 * queue job for the reason the checkout service states about `order.autoCancel`:
 * a queue is not transactional, and an enqueue inside the transaction that
 * created the team can be delivered before — or without — the row it names. The
 * effects ledger is written in that same transaction and `run_at` carries the
 * delay, so the timer exists exactly when the team does.
 */

// ---------------------------------------------------------------------------
// the system-initiated refund
// ---------------------------------------------------------------------------

/**
 * How a failed team gives the money back.
 *
 * The default is `refundSystemInitiated` from `refund/index.ts`. The port
 * exists because a unit test that wants to watch the effect handler should not
 * have to stand up a paid order, a payment attempt and a refundable line;
 * `registerAutoRefundPort` lets it substitute a spy.
 *
 * What it is *not* is an extension point: the only registration outside a test
 * is the default below, and anything that opens a `refunds` row still goes
 * through the refund domain's own entry point, ceiling check and all.
 */
export interface AutoRefundPort {
  refund(
    tx: Tx,
    ctx: Ctx,
    input: { orderId: number; reason: 'groupbuy_failed'; note?: string },
  ): Promise<{ refundId: number; created: boolean }>;
}

const defaultAutoRefundPort: AutoRefundPort = {
  refund: (tx, ctx, input) => refundSystemInitiated(tx, ctx, input),
};

let autoRefundPort: AutoRefundPort = defaultAutoRefundPort;

export function registerAutoRefundPort(port: AutoRefundPort): void {
  autoRefundPort = port;
}

/** Test helper: puts the real refund entry point back. */
export function clearAutoRefundPort(): void {
  autoRefundPort = defaultAutoRefundPort;
}

export function peekAutoRefundPort(): AutoRefundPort {
  return autoRefundPort;
}

interface RefundPayload {
  orderId: string;
  groupId: string;
  reason: string;
}

/**
 * Gives a member their money back when the team did not happen.
 *
 * One transaction per member, opened here rather than by the sweep that
 * recorded the effect: a team of five that fails is five refunds, and one bad
 * order — a line that shipped between the sweep and the effect, say — must not
 * roll back the other four. The ledger's `UNIQUE (scope, scope_id,
 * event_type)` gives exactly one effect per member's order however many sweeps
 * run, and `refundSystemInitiated` is idempotent per `(orderId, reason)` on top
 * of that, so a retried effect finds the refund it already opened and returns
 * it instead of opening a second.
 *
 * The 拼团失败 notice is recorded in the same transaction, so it exists exactly
 * when the refund does and can say the money is on its way.
 *
 * A throw here is still the right failure: the dispatcher retries eight times
 * and then parks the row as `unknown`, where the 待处理任务 console lists it
 * (it filters `scope in ('payment','refund','order')`, and this effect's scope
 * is `order`) and an operator settles it by hand. Swallowing the error would
 * lose a shopper's money quietly.
 */
async function handleRefundEffect(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = effect.payload as RefundPayload;
  const orderId = Number(payload.orderId);
  const port = autoRefundPort;
  const result = await ctx.withTx(async (tx) => {
    const refund = await port.refund(tx, ctx, {
      orderId,
      reason: 'groupbuy_failed',
      note: `拼团 ${payload.groupId} ${payload.reason === 'seat_lost' ? '名额已满' : '未成团'}`,
    });
    await notifyFailed(tx, ctx, { orderId, reason: payload.reason, refundId: refund.refundId });
    return refund;
  });
  ctx.logger.info(
    {
      orderId: payload.orderId,
      groupId: payload.groupId,
      refundId: String(result.refundId),
      created: result.created,
    },
    'groupbuy: failed team refunded',
  );
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

/** What the shopper is told a failed seat was about. */
const FAILURE_REASONS: Record<string, string> = {
  group_failed: '拼团人数未满，未能成团',
  seat_lost: '拼团名额已被占满',
  quota_reached: '活动名额已售罄',
};

/**
 * 开团成功 / 参团成功, for the shopper whose paid order just took a seat.
 *
 * Read at dispatch time, not at payment: the message goes out after commit,
 * and a shopper who has already left the team (refunded between the payment
 * and this effect) is not told they joined it. The role comes from the payload,
 * because a member promoted since, when the leader left, did not open the team.
 *
 * `notify` records one more effect keyed on this order, so a retried
 * `groupbuy.join` finds it already there and sends nothing twice.
 */
async function handleJoinEffect(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = effect.payload as { orderId: string; role?: 'leader' | 'member' };
  const notice = await repo.findMemberNotice(ctx.db, Number(payload.orderId));
  if (!notice || notice.memberStatus !== 'joined') return;

  const role = payload.role ?? notice.role;
  await ctx.withTx((tx) =>
    notify(tx, ctx, {
      event: role === 'leader' ? GROUPBUY_EVENTS.created : GROUPBUY_EVENTS.joined,
      subject: { scope: 'order', id: notice.orderId },
      userId: notice.userId,
      data: {
        orderId: notice.orderId,
        orderNo: notice.orderNo,
        groupId: notice.groupId,
        activityTitle: notice.activityTitle,
        seatsTotal: notice.seatsTotal,
        seatsLeft: Math.max(notice.seatsTotal - notice.seatsTaken, 0),
        expiresAt: formatShopTime(notice.expiresAt, 'minute'),
      },
    }),
  );
}

/**
 * 拼团成功, once per paid member.
 *
 * Fans out to the paid members still in the team when the effect runs — a
 * virtual fill adds no member rows, so only real shoppers are told. Each
 * member's notice is its own effect keyed on their order, so a retried settle
 * records nothing new and nobody is told twice.
 *
 * It is also where a member's card keys and coupon goods go out (RISK-D-011): auto-delivery
 * on payment held back while the team was forming, and runs again here. `autoDeliver` is
 * idempotent per order, so a retried settle hands nothing over twice; one member's order
 * short of card keys fails this effect for a retry without holding back the others.
 *
 * A failed team sends nothing from here. Each paid member of it has a
 * `groupbuy.refund` effect, and that is where they hear about it — with the
 * refund already open.
 */
async function handleSettleEffect(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = effect.payload as { groupId: string; outcome: 'succeeded' | 'failed' };
  if (payload.outcome !== 'succeeded') return;

  const groupId = Number(payload.groupId);
  const group = await repo.findGroupRow(ctx.db, groupId);
  if (!group || group.status !== 'succeeded') return;
  const members = await repo.listPaidMembers(ctx.db, groupId);
  if (members.length === 0) return;

  await ctx.withTx(async (tx) => {
    for (const member of members) {
      await notify(tx, ctx, {
        event: GROUPBUY_EVENTS.succeeded,
        subject: { scope: 'order', id: member.orderId },
        userId: member.userId,
        data: {
          orderId: member.orderId,
          orderNo: member.orderNo,
          groupId,
          activityTitle: group.activityTitle,
          seatsTotal: group.seatsTotal,
        },
      });
    }
  });

  const undelivered: number[] = [];
  for (const member of members) {
    try {
      await autoDeliver(ctx, member.orderId);
    } catch (error) {
      ctx.logger.warn(
        { err: error, orderId: member.orderId, groupId },
        'groupbuy: delivery failed',
      );
      undelivered.push(member.orderId);
    }
  }
  if (undelivered.length > 0) {
    const failed = `拼团 ${groupId} 成团后自动发货失败：订单 ${undelivered.join(', ')}`;
    throw new SummarizedError(failed, failed);
  }
}

/**
 * 拼团失败, inside the transaction that opened the refund.
 *
 * The amount is what the shopper paid: a system refund of a group-buy order
 * gives back every line, and nothing ships before a team succeeds.
 */
async function notifyFailed(
  tx: Tx,
  ctx: Ctx,
  args: { orderId: number; reason: string; refundId: number },
): Promise<void> {
  const notice = await repo.findMemberNotice(tx, args.orderId);
  if (!notice) return;
  await notify(tx, ctx, {
    event: GROUPBUY_EVENTS.failed,
    subject: { scope: 'order', id: notice.orderId },
    userId: notice.userId,
    data: {
      orderId: notice.orderId,
      orderNo: notice.orderNo,
      groupId: notice.groupId,
      activityTitle: notice.activityTitle,
      amount: notice.paidAmount ?? '',
      refundNote: refundNoteOf(notice.paidAmount),
      reason: FAILURE_REASONS[args.reason] ?? FAILURE_REASONS['group_failed'],
      refundId: args.refundId,
    },
  });
}

// ---------------------------------------------------------------------------
// the expiry timer
// ---------------------------------------------------------------------------

/**
 * Settles one team the moment its clock runs out.
 *
 * Idempotent and safe to arrive late: `settleGroup` re-reads the group under a
 * lock and every transition it makes is conditional, so a team that already
 * succeeded, failed or was settled by the sweep is left exactly as it is.
 */
async function handleExpiryEffect(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = effect.payload as { groupId: string };
  const result = await settleGroup(ctx, Number(payload.groupId));
  if (result.outcome !== 'unchanged') {
    ctx.logger.info({ ...result }, 'groupbuy: team settled on its own timer');
  }
}

/** Idempotent; `registerEffectHandler` replaces by `(scope, eventType)`. */
export function registerGroupbuyEffects(): void {
  registerEffectHandler('order', 'groupbuy.join', handleJoinEffect);
  registerEffectHandler('groupbuy', 'groupbuy.settle', handleSettleEffect);
  registerEffectHandler('order', 'groupbuy.refund', handleRefundEffect);
  registerEffectHandler('groupbuy', 'groupbuy.expire', handleExpiryEffect);
}
