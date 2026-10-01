import { describe, expect, it } from 'vitest';
import {
  inviteTitle,
  myTeamStatus,
  seatsOf,
  teamActions,
  teamHeadline,
  teamPhase,
  type TeamView,
} from './team';

const NOW = Date.parse('2026-09-24T10:00:00+08:00');
const LATER = '2026-09-24T12:00:00+08:00';
const EARLIER = '2026-09-24T09:00:00+08:00';

function view(patch: Partial<TeamView> = {}): TeamView {
  return {
    groupId: '501',
    activityId: '1',
    title: '双人团 · 护理套装',
    imageUrl: null,
    price: '68.00',
    status: 'forming',
    seatsTotal: 2,
    seatsTaken: 1,
    seatsLeft: 1,
    expiresAt: LATER,
    succeededAt: null,
    members: [{ nickname: '甲', avatarUrl: null, role: 'leader', isMe: false }],
    me: null,
    canJoin: true,
    ...patch,
  };
}

const paidLeader = { role: 'leader', status: 'joined', orderId: '70', paid: true } as const;

describe('teamPhase', () => {
  it.each([
    ['open while forming and in time', view(), 'open'],
    ['settling once the deadline passed', view({ expiresAt: EARLIER }), 'settling'],
    ['settling when every seat is taken', view({ seatsLeft: 0, seatsTaken: 2 }), 'settling'],
    ['full when succeeded', view({ status: 'succeeded' }), 'full'],
    ['cancelled when withdrawn', view({ status: 'cancelled' }), 'cancelled'],
    ['failed for a visitor', view({ status: 'failed' }), 'failed'],
    [
      'failed while a paid member waits for the refund',
      view({ status: 'failed', me: paidLeader }),
      'failed',
    ],
    [
      'refunded once the member is refunded',
      view({ status: 'failed', me: { ...paidLeader, status: 'refunded', paid: false } }),
      'refunded',
    ],
  ] as const)('%s', (_name, input, phase) => {
    expect(teamPhase(input, NOW)).toBe(phase);
  });
});

describe('teamHeadline', () => {
  it('says how many are missing and what happens if nobody comes (虚拟成团 off)', () => {
    const headline = teamHeadline(view(), 'open');
    expect(headline.title).toBe('还差 1 人成团');
    expect(headline.note).toContain('到时间未凑齐将自动取消');
    expect(headline.note).toContain('原路退回');
  });

  it('tells a paid member of a failed team that the refund is on its way', () => {
    expect(teamHeadline(view({ me: paidLeader }), 'failed').note).toContain('退款处理中');
    expect(teamHeadline(view(), 'refunded').title).toBe('拼团未成功，已退款');
    // A ¥0 team charged nothing: no refund to promise.
    expect(teamHeadline(view({ price: '0.00', me: paidLeader }), 'failed').note).toBe(
      '到时间未凑齐 2 人，订单已关闭，没有产生扣款',
    );
    expect(teamHeadline(view({ price: '0.00' }), 'refunded')).toMatchObject({
      title: '拼团未成功，订单已关闭',
      note: '没有产生扣款',
    });
  });
});

describe('teamActions', () => {
  it('offers 参团 to a visitor who may join', () => {
    expect(teamActions(view(), 'open')).toEqual([{ kind: 'join' }]);
  });

  it('offers invite and poster to a paid member of an open team', () => {
    expect(teamActions(view({ me: paidLeader, canJoin: false }), 'open')).toEqual([
      { kind: 'invite' },
      { kind: 'poster' },
    ]);
  });

  it('offers 去支付 and 取消拼团 to an unpaid leader of an empty team', () => {
    const me = { ...paidLeader, paid: false };
    expect(teamActions(view({ me, seatsTaken: 0, canJoin: false }), 'open')).toEqual([
      { kind: 'pay', orderId: '70' },
      { kind: 'withdraw' },
    ]);
  });

  it('never offers 取消拼团 once somebody has paid', () => {
    const me = { ...paidLeader, paid: false };
    expect(teamActions(view({ me, seatsTaken: 1, canJoin: false }), 'open')).toEqual([
      { kind: 'pay', orderId: '70' },
    ]);
  });

  it('points a visitor who cannot join to another team', () => {
    expect(teamActions(view({ canJoin: false }), 'open')).toEqual([{ kind: 'again' }]);
  });

  it.each(['full', 'failed', 'refunded'] as const)(
    'shows the order of a member when %s',
    (phase) => {
      const me =
        phase === 'refunded'
          ? { ...paidLeader, status: 'refunded' as const, paid: false }
          : paidLeader;
      expect(teamActions(view({ me }), phase)).toEqual([
        { kind: 'order', orderId: '70' },
        { kind: 'again' },
      ]);
    },
  );

  it('treats a cancelled (never paid) membership as a visitor', () => {
    const me = { ...paidLeader, status: 'cancelled' as const, paid: false };
    expect(teamActions(view({ me, status: 'succeeded' }), 'full')).toEqual([{ kind: 'again' }]);
  });
});

describe('seatsOf', () => {
  it('fills the open places with empty seats', () => {
    expect(seatsOf(view({ seatsTotal: 3 }))).toHaveLength(3);
    expect(seatsOf(view({ seatsTotal: 3 }))[2]).toBeNull();
  });
});

describe('inviteTitle', () => {
  it('states the facts only', () => {
    expect(inviteTitle(view())).toBe('还差 1 人成团 · ¥68.00 双人团 · 护理套装');
    expect(inviteTitle(view({ seatsLeft: 0 }))).toBe('¥68.00 双人团 · 护理套装');
  });
});

describe('myTeamStatus', () => {
  const item = {
    status: 'forming',
    memberStatus: 'joined',
    seatsTotal: 3,
    seatsTaken: 1,
    expiresAt: LATER,
  } as const;
  it.each([
    [item, '拼团中 · 还差 2 人'],
    [{ ...item, expiresAt: EARLIER }, '结算中'],
    [{ ...item, status: 'succeeded' }, '拼团成功'],
    [{ ...item, status: 'failed' }, '未成团，退款中'],
    [{ ...item, status: 'failed', memberStatus: 'refunded' }, '未成团，已退款'],
    [{ ...item, memberStatus: 'cancelled' }, '未支付，已取消'],
    [{ ...item, status: 'cancelled' }, '已取消'],
  ] as const)('%o → %s', (input, text) => {
    expect(myTeamStatus(input, NOW).text).toBe(text);
  });
});
