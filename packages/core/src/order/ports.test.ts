import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../kernel/clock';
import { anonymousActor, createCtx, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { silentLogger } from '../kernel/logger';
import { Money } from '../kernel/money';
import { memoryQueue } from '../kernel/queue';
import { memoryStorage } from '../kernel/storage';
import {
  allOrderKinds,
  canTransition,
  getFreightPort,
  getOrderKindHandler,
  getOrderStateMachine,
  getPaymentPort,
  getPricingContributors,
  getStockPort,
  onOrderCancelled,
  onOrderCompleted,
  onOrderPaid,
  onOrderRefunded,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  registerFreightPort,
  registerOrderKindHandler,
  registerOrderStateMachine,
  registerPaymentPort,
  registerPricingContributor,
  registerStockPort,
  resetOrderPorts,
  type OrderPaidEvent,
} from './ports';

const ctx: Ctx = createCtx({
  db: {} as never,
  redis: {} as never,
  clock: fixedClock(),
  config: {} as never,
  logger: silentLogger(),
  queue: memoryQueue(),
  storage: memoryStorage(),
  actor: anonymousActor,
  platform: null,
  requestId: 'req-test',
});

const tx = {} as never;

const paidEvent: OrderPaidEvent = {
  orderId: 1,
  orderNo: '20260101120000000',
  userId: 7,
  at: new Date('2026-01-01T00:00:00Z'),
  paidAmount: Money.parse('19.90'),
};

afterEach(() => {
  resetOrderPorts();
});

describe('the transition table', () => {
  it('allows only the documented moves', () => {
    expect(canTransition('pending_payment', 'paid')).toBe(true);
    expect(canTransition('pending_payment', 'cancelled')).toBe(true);
    expect(canTransition('paid', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'received')).toBe(true);
    expect(canTransition('received', 'completed')).toBe(true);
  });

  it('treats cancelled and refunded as terminal', () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransition('cancelled', to), `cancelled -> ${to}`).toBe(false);
      expect(canTransition('refunded', to), `refunded -> ${to}`).toBe(false);
    }
  });

  it('lets a paid order leave only through shipping or a full refund', () => {
    expect(canTransition('paid', 'cancelled')).toBe(false);
    for (const from of ['paid', 'shipped', 'received', 'completed'] as const) {
      expect(canTransition(from, 'refunded'), `${from} -> refunded`).toBe(true);
    }
  });

  it('refuses the moves that would skip payment or delivery', () => {
    expect(canTransition('pending_payment', 'shipped')).toBe(false);
    expect(canTransition('paid', 'received')).toBe(false);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
  });

  it('is frozen, so no domain can widen it at runtime', () => {
    expect(Object.isFrozen(ORDER_TRANSITIONS)).toBe(true);
  });
});

describe('lifecycle hook registries', () => {
  it('runs hooks in registration order inside the caller transaction', async () => {
    const order: string[] = [];
    onOrderPaid.register('a:one', async () => {
      order.push('one');
    });
    onOrderPaid.register('b:two', async () => {
      order.push('two');
    });
    await onOrderPaid.dispatch(tx, ctx, paidEvent);
    expect(order).toEqual(['one', 'two']);
    expect(onOrderPaid.names()).toEqual(['a:one', 'b:two']);
  });

  it('replaces a hook registered twice under the same name', async () => {
    const calls: string[] = [];
    onOrderPaid.register('x', async () => {
      calls.push('first');
    });
    onOrderPaid.register('x', async () => {
      calls.push('second');
    });
    await onOrderPaid.dispatch(tx, ctx, paidEvent);
    expect(calls).toEqual(['second']);
  });

  it('propagates a throwing hook so the whole transaction rolls back', async () => {
    const after = vi.fn();
    onOrderPaid.register('boom', async () => {
      throw new DomainError('GROUPBUY_TEAM_FULL', { message: '团已满' });
    });
    onOrderPaid.register('after', after);
    await expect(onOrderPaid.dispatch(tx, ctx, paidEvent)).rejects.toThrow('团已满');
    expect(after).not.toHaveBeenCalled();
  });

  it('gives each lifecycle event its own registry', async () => {
    const seen: string[] = [];
    onOrderPaid.register('h', async () => void seen.push('paid'));
    onOrderCancelled.register('h', async () => void seen.push('cancelled'));
    onOrderRefunded.register('h', async () => void seen.push('refunded'));
    onOrderCompleted.register('h', async () => void seen.push('completed'));

    await onOrderCancelled.dispatch(tx, ctx, { ...paidEvent, reason: 'timeout' });
    await onOrderCompleted.dispatch(tx, ctx, { ...paidEvent, completedBy: 'auto' });
    expect(seen).toEqual(['cancelled', 'completed']);
  });

  it('is emptied by resetOrderPorts', async () => {
    onOrderPaid.register('h', async () => {});
    resetOrderPorts();
    expect(onOrderPaid.names()).toEqual([]);
  });
});

describe('port registration', () => {
  it('throws a clear DomainError until the owning domain registers', () => {
    for (const get of [getStockPort, getPaymentPort, getFreightPort, getOrderStateMachine]) {
      expect(get).toThrow(DomainError);
      expect(get).toThrow('尚未注册');
    }
  });

  it('hands back what was registered', async () => {
    registerStockPort({
      reserve: async () => [],
      release: async () => {},
      commit: async () => {},
    });
    registerPaymentPort({
      ensureNoOpenAttempts: async () => 'closed',
      closeOrderPayments: async () => 'closed',
    });
    registerFreightPort({ quote: async () => ({ totalFen: 500, perLine: [500] }) });
    registerOrderStateMachine({
      table: ORDER_TRANSITIONS,
      transition: async () => ({ won: true, affected: 1 }),
    });

    expect(await getStockPort().reserve(tx, 1, [])).toEqual([]);
    expect(await getPaymentPort().ensureNoOpenAttempts(tx, 1)).toBe('closed');
    expect(await getPaymentPort().closeOrderPayments(ctx, 1)).toBe('closed');
    expect(await getFreightPort().quote(tx, ctx, { addressCityId: null, lines: [] })).toEqual({
      totalFen: 500,
      perLine: [500],
    });
    expect((await getOrderStateMachine().transition(tx, 1, ['pending_payment'], 'paid')).won).toBe(
      true,
    );
  });

  it('models the three payment answers the cancel path must handle', async () => {
    for (const answer of ['closed', 'paid', 'unknown'] as const) {
      registerPaymentPort({
        ensureNoOpenAttempts: async () => answer,
        closeOrderPayments: async () => answer,
      });
      expect(await getPaymentPort().ensureNoOpenAttempts(tx, 1)).toBe(answer);
      // Both halves of the two-call protocol speak the same three answers.
      expect(await getPaymentPort().closeOrderPayments(ctx, 1)).toBe(answer);
    }
  });
});

describe('pricing contributors', () => {
  const contributor = (name: string, priority: number) => ({
    name,
    priority,
    contribute: async () => [],
  });

  it('is sorted by priority, then registration order', () => {
    registerPricingContributor(contributor('coupon', 100));
    registerPricingContributor(contributor('groupbuy', 10));
    registerPricingContributor(contributor('presale', 10));
    expect(getPricingContributors().map((c) => c.name)).toEqual(['groupbuy', 'presale', 'coupon']);
  });

  it('replaces a contributor registered twice under the same name', () => {
    registerPricingContributor(contributor('coupon', 100));
    registerPricingContributor(contributor('coupon', 5));
    expect(getPricingContributors()).toHaveLength(1);
    expect(getPricingContributors()[0]?.priority).toBe(5);
  });
});

describe('order kind handlers', () => {
  it('registers group-buy and presale side by side', () => {
    const handler = (kind: string) => ({
      kind,
      beforeCreate: async () => ({}),
      afterCreate: async () => {},
    });
    registerOrderKindHandler(handler('groupbuy'));
    registerOrderKindHandler(handler('presale'));
    expect(allOrderKinds()).toEqual(['groupbuy', 'presale']);
    expect(getOrderKindHandler('groupbuy')?.kind).toBe('groupbuy');
    expect(getOrderKindHandler('nope')).toBeUndefined();
  });
});
