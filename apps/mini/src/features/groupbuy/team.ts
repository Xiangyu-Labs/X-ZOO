import type { ResponseOf } from '@shop/api-client';

export type TeamView = ResponseOf<'groupbuy.groupDetail'>;
export type MyTeam = ResponseOf<'groupbuy.myGroups'>['items'][number];

/**
 * What the team page shows, from the viewer's side (pages.md §2.5, RISK-D-001…009):
 *
 * - `open`: forming and still in time;
 * - `settling`: forming, but the deadline has passed or the seats are all taken, and the server
 *   has not settled it yet (the sweep runs every minute);
 * - `full`: 拼团成功;
 * - `failed`: did not fill in time; a paid member's refund is on its way;
 * - `refunded`: did not fill, and this viewer's money is back;
 * - `cancelled`: the leader withdrew before anyone paid.
 *
 * 虚拟成团 is off: a team that does not fill always fails and refunds, and the page says so.
 */
export type TeamPhase = 'open' | 'settling' | 'full' | 'failed' | 'refunded' | 'cancelled';

export function teamPhase(
  view: Pick<TeamView, 'status' | 'seatsLeft' | 'expiresAt' | 'me'>,
  nowMs: number,
): TeamPhase {
  switch (view.status) {
    case 'succeeded':
      return 'full';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return view.me?.status === 'refunded' ? 'refunded' : 'failed';
    case 'forming':
      return nowMs >= Date.parse(view.expiresAt) || view.seatsLeft === 0 ? 'settling' : 'open';
  }
}

export interface TeamHeadline {
  title: string;
  /** A factual second line (C10: no pressure, no rewards). */
  note: string;
  tone: 'primary' | 'success' | 'muted';
}

/** The words at the top of the team page. */
export function teamHeadline(
  view: Pick<TeamView, 'seatsTotal' | 'seatsLeft' | 'me' | 'price'>,
  phase: TeamPhase,
): TeamHeadline {
  const paidMember = view.me?.paid === true;
  // A ¥0 team (a free trial): nothing was charged, so nothing is refunded either.
  const free = Number(view.price) <= 0;
  switch (phase) {
    case 'open':
      return {
        title: `还差 ${view.seatsLeft} 人成团`,
        note: `${view.seatsTotal} 人成团，到时间未凑齐将自动取消，已付款项原路退回`,
        tone: 'primary',
      };
    case 'settling':
      return view.seatsLeft === 0
        ? { title: '人数已满，正在确认成团', note: '稍后刷新即可看到结果', tone: 'primary' }
        : {
            title: '拼团时间已到，正在结算',
            note: `未凑齐 ${view.seatsTotal} 人的团会自动取消，已付款项原路退回`,
            tone: 'muted',
          };
    case 'full':
      return {
        title: '拼团成功',
        note: view.me ? '商家将尽快为你发货' : `${view.seatsTotal} 人已成团`,
        tone: 'success',
      };
    case 'failed':
      return {
        title: '拼团未成功',
        note: free
          ? `到时间未凑齐 ${view.seatsTotal} 人，订单已关闭，没有产生扣款`
          : paidMember
            ? `到时间未凑齐 ${view.seatsTotal} 人，退款处理中，将原路退回`
            : `到时间未凑齐 ${view.seatsTotal} 人，已付款项原路退回`,
        tone: 'muted',
      };
    case 'refunded':
      return free
        ? { title: '拼团未成功，订单已关闭', note: '没有产生扣款', tone: 'muted' }
        : { title: '拼团未成功，已退款', note: '款项已原路退回，请留意到账', tone: 'muted' };
    case 'cancelled':
      return { title: '拼团已取消', note: '团长已取消这个团', tone: 'muted' };
  }
}

/** What the viewer can do on the team page, most important first. */
export type TeamAction =
  | { kind: 'join' }
  | { kind: 'pay'; orderId: string }
  | { kind: 'withdraw' }
  | { kind: 'invite' }
  | { kind: 'poster' }
  | { kind: 'order'; orderId: string }
  | { kind: 'again' }
  | { kind: 'refresh' };

export function teamActions(
  view: Pick<TeamView, 'seatsTaken' | 'me' | 'canJoin'>,
  phase: TeamPhase,
): TeamAction[] {
  const me = view.me && view.me.status !== 'cancelled' ? view.me : null;
  if (phase === 'open') {
    if (me && !me.paid) {
      const out: TeamAction[] = [{ kind: 'pay', orderId: me.orderId }];
      if (me.role === 'leader' && view.seatsTaken === 0) out.push({ kind: 'withdraw' });
      return out;
    }
    if (me) return [{ kind: 'invite' }, { kind: 'poster' }];
    if (view.canJoin) return [{ kind: 'join' }];
    return [{ kind: 'again' }];
  }
  if (phase === 'settling') {
    return me ? [{ kind: 'refresh' }, { kind: 'order', orderId: me.orderId }] : [{ kind: 'again' }];
  }
  // full, failed, refunded, cancelled
  if (me && (me.paid || me.status === 'refunded' || phase === 'failed')) {
    return [{ kind: 'order', orderId: me.orderId }, { kind: 'again' }];
  }
  return [{ kind: 'again' }];
}

/** Seats for the member row: the paid members, then an empty seat per place still open. */
export function seatsOf(
  view: Pick<TeamView, 'members' | 'seatsTotal'>,
): Array<TeamView['members'][number] | null> {
  const seats: Array<TeamView['members'][number] | null> = [...view.members];
  while (seats.length < view.seatsTotal) seats.push(null);
  return seats;
}

/** The share title (C10: a fact, never a reward or a plea). */
export function inviteTitle(view: Pick<TeamView, 'title' | 'seatsLeft' | 'price'>): string {
  return view.seatsLeft > 0
    ? `还差 ${view.seatsLeft} 人成团 · ¥${view.price} ${view.title}`
    : `¥${view.price} ${view.title}`;
}

/** The status line on 我的拼团 for one of the shopper's teams. */
export function myTeamStatus(
  item: Pick<MyTeam, 'status' | 'memberStatus' | 'seatsTotal' | 'seatsTaken' | 'expiresAt'>,
  nowMs: number,
): { text: string; tone: 'primary' | 'success' | 'default' } {
  if (item.memberStatus === 'cancelled') return { text: '未支付，已取消', tone: 'default' };
  switch (item.status) {
    case 'succeeded':
      return { text: '拼团成功', tone: 'success' };
    case 'cancelled':
      return { text: '已取消', tone: 'default' };
    case 'failed':
      return {
        text: item.memberStatus === 'refunded' ? '未成团，已退款' : '未成团，退款中',
        tone: 'default',
      };
    case 'forming': {
      if (nowMs >= Date.parse(item.expiresAt)) return { text: '结算中', tone: 'default' };
      const left = Math.max(0, item.seatsTotal - item.seatsTaken);
      return { text: left > 0 ? `拼团中 · 还差 ${left} 人` : '拼团中', tone: 'primary' };
    }
  }
}
