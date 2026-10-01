import { describe, expect, it } from 'vitest';
import { registerAllDomains } from '../domains.gen';
import { COMMIT_SALE_HOOK } from './order.stock.hooks';
import { onOrderPaid, resetOrderPorts } from './ports';

/**
 * The campaign hooks say the SKU-level sale "just" happened, so the commit has
 * to run ahead of them. What is asserted is the production module graph — a
 * fresh import of every domain, the way the web process and the worker load
 * them — not a test's `resetOrderPorts()` re-registration, whose order is
 * whatever the test calls.
 */
describe('the paid hook that commits the sale', () => {
  it('runs first, ahead of the group-buy seat and the presale sale', () => {
    const names = onOrderPaid.names();
    expect(names[0]).toBe(COMMIT_SALE_HOOK);
    expect(names).toContain('groupbuy:take-seat');
    expect(names).toContain('presale:commit-sale');
    expect(names.filter((name) => name === COMMIT_SALE_HOOK)).toHaveLength(1);
  });
});

/**
 * The module graph above decides the order once; tests (and anything else) that
 * call `resetOrderPorts()` and then `registerAllDomains()` get the order the
 * generated registrar's calls give, so that has to put the order domain first
 * too.
 */
describe('after resetOrderPorts() + registerAllDomains()', () => {
  it('still runs the sale commit first', () => {
    resetOrderPorts();
    expect(onOrderPaid.names()).toEqual([]);
    registerAllDomains();
    const names = onOrderPaid.names();
    expect(names[0]).toBe(COMMIT_SALE_HOOK);
    expect(names).toContain('groupbuy:take-seat');
    expect(names).toContain('presale:commit-sale');
    expect(names.filter((name) => name === COMMIT_SALE_HOOK)).toHaveLength(1);
  });
});
