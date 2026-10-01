import { describe, expect, it } from 'vitest';
import { defineFactory, oneOf, seq } from './factories';
import {
  fakeOrderStateMachine,
  fakePaymentPort,
  fakeStockPort,
  fakeUserLookup,
  flatRateFreight,
  freeFreight,
} from './fakes';

const tx = {} as never;
const ctx = {} as never;

describe('fakePaymentPort', () => {
  it('answers `closed` by default and records the orders it was asked about', async () => {
    const port = fakePaymentPort();
    expect(await port.ensureNoOpenAttempts(tx, 42)).toBe('closed');
    expect(port.calls).toEqual([42]);
  });

  it('can be set to every answer the cancel path must handle', async () => {
    const port = fakePaymentPort({ result: 'paid' });
    expect(await port.ensureNoOpenAttempts(tx, 1)).toBe('paid');
    port.setResult('unknown');
    expect(await port.ensureNoOpenAttempts(tx, 1)).toBe('unknown');
  });

  it('answers both halves of the cancel protocol and records each separately', async () => {
    const port = fakePaymentPort({ result: 'unknown' });
    expect(await port.closeOrderPayments(ctx, 7)).toBe('unknown');
    expect(port.closes).toEqual([7]);
    // The close is not an `ensureNoOpenAttempts` call and must not be counted as one.
    expect(port.calls).toEqual([]);
  });

  it('can split the two halves, so the re-check under the lock differs', async () => {
    const port = fakePaymentPort({ result: 'paid', closeResult: 'closed' });
    expect(await port.closeOrderPayments(ctx, 3)).toBe('closed');
    expect(await port.ensureNoOpenAttempts(tx, 3)).toBe('paid');

    port.setCloseResult('unknown');
    expect(await port.closeOrderPayments(ctx, 3)).toBe('unknown');
    expect(port.closes).toEqual([3, 3]);
  });
});

describe('flatRateFreight', () => {
  it('splits the fee so perLine always sums to totalFen', async () => {
    const port = flatRateFreight(1000);
    // `freightMode` / `fixedFreightFen` are part of a `FreightLine`; the
    // flat-rate fake ignores both, but the shape has to be whole.
    const line = (skuId: number) => ({
      skuId,
      quantity: 1,
      freightMode: 'free' as const,
      fixedFreightFen: 0,
      freightTemplateId: null,
      weight: 0,
      volume: 0,
      amountFen: 100,
    });
    const quote = await port.quote(ctx, ctx, {
      addressCityId: 1,
      lines: [line(1), line(2), line(3)],
    });
    expect(quote.totalFen).toBe(1000);
    expect(quote.perLine).toEqual([334, 333, 333]);
    expect(quote.perLine.reduce((a, b) => a + b, 0)).toBe(quote.totalFen);
    expect(port.quotes).toHaveLength(1);
  });

  it('handles an empty cart and a free quote', async () => {
    expect(await flatRateFreight(500).quote(ctx, ctx, { addressCityId: null, lines: [] })).toEqual({
      totalFen: 0,
      perLine: [],
    });
    const free = await freeFreight().quote(ctx, ctx, {
      addressCityId: null,
      lines: [
        {
          skuId: 1,
          quantity: 1,
          freightMode: 'free' as const,
          fixedFreightFen: 0,
          freightTemplateId: null,
          weight: 0,
          volume: 0,
          amountFen: 1,
        },
      ],
    });
    expect(free).toEqual({ totalFen: 0, perLine: [0] });
  });
});

describe('fakeStockPort', () => {
  it('reserves, and reports the lines it could not satisfy', async () => {
    const stock = fakeStockPort({ 1: 5, 2: 0 });
    expect(await stock.reserve(tx, 100, [{ skuId: 1, quantity: 2 }])).toEqual([]);
    expect(stock.available.get(1)).toBe(3);

    const short = await stock.reserve(tx, 101, [{ skuId: 2, quantity: 1 }]);
    expect(short).toEqual([{ skuId: 2, quantity: 1 }]);
    // An unsatisfiable reservation must be all-or-nothing.
    expect(stock.available.get(1)).toBe(3);
  });

  it('release is idempotent — the ledger may call it twice', async () => {
    const stock = fakeStockPort({ 1: 5 });
    const lines = [{ skuId: 1, quantity: 2 }];
    await stock.reserve(tx, 100, lines);
    await stock.release(tx, 100, lines);
    await stock.release(tx, 100, lines);
    expect(stock.available.get(1)).toBe(5);
    expect(stock.released).toEqual([100]);
  });

  it('commit turns a reservation into a sale', async () => {
    const stock = fakeStockPort({ 1: 5 });
    await stock.reserve(tx, 100, [{ skuId: 1, quantity: 2 }]);
    await stock.commit(tx, 100, [{ skuId: 1, quantity: 2 }]);
    expect(stock.committed).toEqual([100]);
    // Committed stock does not come back on a later release.
    await stock.release(tx, 100, [{ skuId: 1, quantity: 2 }]);
    expect(stock.available.get(1)).toBe(3);
  });
});

describe('fakeOrderStateMachine', () => {
  it('behaves like a conditional update: the second caller loses', async () => {
    const machine = fakeOrderStateMachine({ 1: 'pending_payment' });
    expect(await machine.transition(tx, 1, ['pending_payment'], 'paid')).toEqual({
      won: true,
      affected: 1,
    });
    const second = await machine.transition(tx, 1, ['pending_payment'], 'paid');
    expect(second.won).toBe(false);
    expect(second.observed).toBe('paid');
  });

  it('reports nothing observed for an order it has never seen', async () => {
    const machine = fakeOrderStateMachine();
    expect(await machine.transition(tx, 9, ['pending_payment'], 'paid')).toEqual({
      won: false,
      affected: 0,
    });
  });
});

describe('fakeUserLookup', () => {
  it('serves the seeded users', async () => {
    const lookup = fakeUserLookup([{ id: 1 }, { id: 2, status: 0 }]);
    expect(await lookup.findAuthState({} as never, 1)).toEqual({
      id: 1,
      passwordVersion: 1,
      status: 1,
    });
    expect(await lookup.findAuthState({} as never, 2)).toMatchObject({ status: 0 });
    expect(await lookup.findAuthState({} as never, 99)).toBeNull();
  });

  it('models a password change and a disable', async () => {
    const lookup = fakeUserLookup([{ id: 1 }]);
    lookup.changePassword(1);
    expect((await lookup.findAuthState({} as never, 1))?.passwordVersion).toBe(2);
    lookup.disable(1);
    expect((await lookup.findAuthState({} as never, 1))?.status).toBe(0);
  });
});

describe('defineFactory', () => {
  it('advances the sequence so unique columns stay unique', async () => {
    const rows: Array<{ code: string }> = [];
    const factory = defineFactory<{ code: string }, { code: string }>({
      build: (sequence) => ({ code: `sku-${sequence}` }),
      insert: async (attrs) => {
        rows.push(attrs);
        return attrs;
      },
    });

    expect(factory.attrs().code).toBe('sku-1');
    expect((await factory.create()).code).toBe('sku-2');
    expect((await factory.createMany(2)).map((r) => r.code)).toEqual(['sku-3', 'sku-4']);
    expect(rows).toHaveLength(3);

    factory.reset();
    expect(factory.attrs().code).toBe('sku-1');
  });

  it('applies overrides over the built attributes', () => {
    const factory = defineFactory<{ code: string; price: number }, unknown>({
      build: (sequence) => ({ code: `sku-${sequence}`, price: 100 }),
      insert: async (attrs) => attrs,
    });
    expect(factory.attrs({ price: 999 })).toEqual({ code: 'sku-1', price: 999 });
  });

  it('oneOf and seq are deterministic', () => {
    const pick = oneOf(['a', 'b', 'c']);
    expect([pick(0), pick(1), pick(2), pick(3)]).toEqual(['a', 'b', 'c', 'a']);
    expect(seq('order')(7)).toBe('order-7');
    expect(() => oneOf([])).toThrow(RangeError);
  });
});
