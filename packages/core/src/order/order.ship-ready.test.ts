import { afterEach, describe, expect, it } from 'vitest';
import { readyToShip } from './order.fulfil.service';
import { registerOrderKindHandler, resetOrderPorts, type OrderKindHandler } from './ports';

const db = {} as never;

function kindWaitingFor(ready: boolean): OrderKindHandler {
  return {
    kind: 'groupbuy',
    beforeCreate: async () => ({}),
    afterCreate: async () => undefined,
    readyToShip: async () => ready,
  };
}

afterEach(() => resetOrderPorts());

describe('RISK-D-011 — an order ships only when its kind says it may', () => {
  it('holds a 拼团 order whose team is still forming', async () => {
    registerOrderKindHandler(kindWaitingFor(false));
    expect(await readyToShip(db, { id: 1, kind: 'groupbuy' })).toBe(false);
  });

  it('lets it go once the team succeeded', async () => {
    registerOrderKindHandler(kindWaitingFor(true));
    expect(await readyToShip(db, { id: 1, kind: 'groupbuy' })).toBe(true);
  });

  it('ships an ordinary order, and a kind that does not ask, once paid', async () => {
    expect(await readyToShip(db, { id: 1, kind: 'normal' })).toBe(true);
    registerOrderKindHandler({ ...kindWaitingFor(false), readyToShip: undefined } as never);
    expect(await readyToShip(db, { id: 1, kind: 'groupbuy' })).toBe(true);
  });
});
