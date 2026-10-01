import { describe, expect, it } from 'vitest';
import {
  computeFreight,
  continuationOnly,
  firstAndContinuation,
  isFreeByRule,
  regionFor,
  unitsOf,
  type FreightInputLine,
  type FreightRegion,
  type FreightTemplateRules,
} from './shipping.freight.rules';

/**
 * The freight rules case by case, including the two an obvious implementation
 * gets wrong: fixed postage is per unit, and a missing continuation rule
 * charges the first price rather than zero.
 */

function region(overrides: Partial<FreightRegion> = {}): FreightRegion {
  return {
    isFallback: true,
    cityIds: new Set(),
    firstUnit: 1,
    firstPriceFen: 1000,
    additionalUnit: 1,
    additionalPriceFen: 500,
    ...overrides,
  };
}

function template(overrides: Partial<FreightTemplateRules> = {}): FreightTemplateRules {
  return {
    templateId: 1,
    chargeMode: 'quantity',
    hasFreeRules: false,
    hasNoDeliveryRules: false,
    regions: [region()],
    freeRules: [],
    noDeliveryCityIds: new Set(),
    ...overrides,
  };
}

function line(overrides: Partial<FreightInputLine> = {}): FreightInputLine {
  return {
    index: 0,
    skuId: 1,
    quantity: 1,
    weight: 0,
    volume: 0,
    amountFen: 10000,
    mode: 'template',
    fixedFreightFen: 0,
    templateId: 1,
    ...overrides,
  };
}

function quote(
  lines: FreightInputLine[],
  templates: FreightTemplateRules[],
  options: { cityPath?: number[]; freeThresholdFen?: number; goodsTotalFen?: number } = {},
) {
  return computeFreight({
    lines,
    cityPath: options.cityPath ?? [330102, 330100, 330000],
    templates: new Map(templates.map((t) => [t.templateId, t])),
    freeThresholdFen: options.freeThresholdFen ?? 0,
    goodsTotalFen: options.goodsTotalFen ?? lines.reduce((sum, l) => sum + l.amountFen, 0),
  });
}

describe('unitsOf', () => {
  it('converts grams to kilograms and cubic centimetres to cubic metres', () => {
    const l = line({ quantity: 2, weight: 3000, volume: 5000 });
    expect(unitsOf(l, 'quantity')).toBe(2);
    expect(unitsOf(l, 'weight')).toBe(3);
    expect(unitsOf(l, 'volume')).toBe(0.005);
  });
});

describe('regionFor', () => {
  const fallback = region({ isFallback: true, firstPriceFen: 1000 });
  const province = region({ isFallback: false, cityIds: new Set([330000]), firstPriceFen: 800 });
  const city = region({ isFallback: false, cityIds: new Set([330100]), firstPriceFen: 500 });

  it('prefers the narrowest rule an operator wrote', () => {
    expect(regionFor([fallback, province, city], [330102, 330100, 330000])).toBe(city);
  });

  it('falls back to the province rule when no city rule matches', () => {
    expect(regionFor([fallback, province, city], [330202, 330200, 330000])).toBe(province);
  });

  it('falls back to the fallback rule when nothing matches', () => {
    expect(regionFor([fallback, province, city], [110101, 110100, 110000])).toBe(fallback);
  });

  it('returns null when the template has no fallback rule at all', () => {
    expect(regionFor([city], [110101])).toBeNull();
  });

  it('gives an address with no known division the fallback rule', () => {
    expect(regionFor([fallback, province, city], [])).toBe(fallback);
  });

  it('returns null for an address with no known division when there is no fallback rule', () => {
    expect(regionFor([province, city], [])).toBeNull();
  });
});

describe('firstAndContinuation', () => {
  it('charges the first price while the cart fits the first unit', () => {
    expect(firstAndContinuation(region({ firstUnit: 2, firstPriceFen: 1000 }), 2)).toBe(1000);
  });

  it('rounds each continuation up', () => {
    // 5 pieces, first 2 cost ¥10, each further 2 cost ¥5 -> ceil(3/2) = 2 lots.
    const r = region({
      firstUnit: 2,
      firstPriceFen: 1000,
      additionalUnit: 2,
      additionalPriceFen: 500,
    });
    expect(firstAndContinuation(r, 5)).toBe(2000);
  });

  it('charges the first price — not zero — when there is no continuation rule', () => {
    // Zero here would make a bigger cart ship free.
    const r = region({
      firstUnit: 1,
      firstPriceFen: 1000,
      additionalUnit: 0,
      additionalPriceFen: 0,
    });
    expect(firstAndContinuation(r, 9)).toBe(1000);
  });
});

describe('continuationOnly', () => {
  it('charges nothing when the template has no continuation rule', () => {
    expect(continuationOnly(region({ additionalUnit: 0 }), 9)).toBe(0);
  });

  it('rounds up over the whole quantity, first unit included', () => {
    expect(continuationOnly(region({ additionalUnit: 2, additionalPriceFen: 500 }), 3)).toBe(1000);
  });
});

describe('isFreeByRule', () => {
  const t = template({
    hasFreeRules: true,
    freeRules: [{ cityIds: new Set([330000]), minUnits: 5, minAmountFen: 19900 }],
  });

  it('needs both thresholds', () => {
    expect(isFreeByRule(t, [330102, 330100, 330000], 5, 19900)).toBe(true);
    expect(isFreeByRule(t, [330102, 330100, 330000], 4, 99900)).toBe(false);
    expect(isFreeByRule(t, [330102, 330100, 330000], 9, 10000)).toBe(false);
  });

  it('treats an unused threshold as satisfied', () => {
    const open = template({
      hasFreeRules: true,
      freeRules: [{ cityIds: new Set([330000]), minUnits: null, minAmountFen: 19900 }],
    });
    expect(isFreeByRule(open, [330000], 1, 19900)).toBe(true);
  });

  it('ignores a rule whose cities do not cover the address', () => {
    expect(isFreeByRule(t, [110101, 110100, 110000], 99, 999900)).toBe(false);
  });

  it('ignores every rule while the template has the flag off', () => {
    const off = template({ hasFreeRules: false, freeRules: t.freeRules });
    expect(isFreeByRule(off, [330000], 99, 999900)).toBe(false);
  });
});

describe('computeFreight', () => {
  it('charges fixed postage per unit, on every line', () => {
    const result = quote(
      [
        line({ index: 0, skuId: 1, mode: 'fixed', fixedFreightFen: 800, quantity: 2 }),
        line({ index: 1, skuId: 2, mode: 'fixed', fixedFreightFen: 300, quantity: 1 }),
      ],
      [],
    );
    // `postage × quantity`, twice — not 800 once.
    expect(result.perLine).toEqual([1600, 300]);
    expect(result.totalFen).toBe(1900);
  });

  it('charges nothing for a free-shipping line', () => {
    const result = quote([line({ mode: 'free', quantity: 3 })], []);
    expect(result.totalFen).toBe(0);
  });

  it('prices an address with no known division at the fallback region', () => {
    // First unit ¥10, each further unit ¥5: 1000 + 2 × 500.
    const result = quote([line({ quantity: 3 })], [template()], { cityPath: [] });
    expect(result.totalFen).toBe(2000);
    expect(result.undeliverable).toEqual([]);
  });

  it('quotes zero for an address with no known division when the template has no fallback region', () => {
    const t = template({
      regions: [region({ isFallback: false, cityIds: new Set([330000]), firstPriceFen: 800 })],
    });
    const result = quote([line({ quantity: 3 })], [t], { cityPath: [] });
    expect(result.totalFen).toBe(0);
  });

  it('prices one template by the matching region', () => {
    const t = template({
      regions: [
        region({
          isFallback: true,
          firstUnit: 1,
          firstPriceFen: 1000,
          additionalUnit: 1,
          additionalPriceFen: 500,
        }),
        region({
          isFallback: false,
          cityIds: new Set([330000]),
          firstUnit: 2,
          firstPriceFen: 600,
          additionalUnit: 1,
          additionalPriceFen: 200,
        }),
      ],
    });
    // 4 pieces in 浙江: first 2 cost ¥6, the other 2 cost ¥2 each.
    const result = quote([line({ quantity: 4 })], [t]);
    expect(result.totalFen).toBe(1000);
  });

  it('drops a whole group when its free rule matches', () => {
    const t = template({
      hasFreeRules: true,
      freeRules: [{ cityIds: new Set([330000]), minUnits: 5, minAmountFen: null }],
    });
    expect(quote([line({ quantity: 5 })], [t]).totalFen).toBe(0);
    expect(quote([line({ quantity: 4 })], [t]).totalFen).toBe(2500);
  });

  it('charges the most expensive arrangement when two templates meet', () => {
    // A: first 1 = ¥10, each further 1 = ¥5. B: first 1 = ¥6, each further = ¥2.
    const a = template({ templateId: 1 });
    const b = template({
      templateId: 2,
      regions: [
        region({ firstUnit: 1, firstPriceFen: 600, additionalUnit: 1, additionalPriceFen: 200 }),
      ],
    });
    const result = quote(
      [
        line({ index: 0, skuId: 1, templateId: 1, quantity: 2 }),
        line({ index: 1, skuId: 2, templateId: 2, quantity: 2 }),
      ],
      [a, b],
    );
    // Only A ties for the highest first price, so A pays 10 + 5 and B pays
    // ceil(2/1) * 2 = 4 in continuations: ¥19.
    expect(result.totalFen).toBe(1900);
    expect(result.perLine).toEqual([1500, 400]);
  });

  it('tries every template that ties for the highest first price and keeps the dearest', () => {
    const a = template({
      templateId: 1,
      regions: [
        region({ firstUnit: 1, firstPriceFen: 1000, additionalUnit: 1, additionalPriceFen: 100 }),
      ],
    });
    const b = template({
      templateId: 2,
      regions: [
        region({ firstUnit: 1, firstPriceFen: 1000, additionalUnit: 1, additionalPriceFen: 900 }),
      ],
    });
    const result = quote(
      [
        line({ index: 0, skuId: 1, templateId: 1, quantity: 3 }),
        line({ index: 1, skuId: 2, templateId: 2, quantity: 3 }),
      ],
      [a, b],
    );
    // Leading with A: (1000 + 2*100) + ceil(3/1)*900 = 3900.
    // Leading with B: (1000 + 2*900) + ceil(3/1)*100 = 3100. The max wins.
    expect(result.totalFen).toBe(3900);
  });

  it('splits a group across its lines by unit share, the last line taking the remainder', () => {
    const t = template({
      regions: [
        region({ firstUnit: 1, firstPriceFen: 1000, additionalUnit: 1, additionalPriceFen: 1 }),
      ],
    });
    const result = quote(
      [
        line({ index: 0, skuId: 1, quantity: 1 }),
        line({ index: 1, skuId: 2, quantity: 1 }),
        line({ index: 2, skuId: 3, quantity: 1 }),
      ],
      [t],
    );
    // ¥10 for the first piece + 1 分 each for the other two = 1002 分 over 3 lines.
    expect(result.totalFen).toBe(1002);
    expect(result.perLine.reduce((sum, v) => sum + v, 0)).toBe(result.totalFen);
    expect(result.perLine).toEqual([334, 334, 334]);
  });

  it('reports every undeliverable line instead of quoting one', () => {
    const t = template({ hasNoDeliveryRules: true, noDeliveryCityIds: new Set([330000]) });
    const result = quote([line({ skuId: 7 })], [t]);
    expect(result.undeliverable).toEqual([{ skuId: 7, templateId: 1 }]);
    expect(result.totalFen).toBe(0);
  });

  it('zeroes the whole order once the shop-wide threshold is met, fixed lines included', () => {
    const result = quote(
      [
        line({
          index: 0,
          skuId: 1,
          mode: 'fixed',
          fixedFreightFen: 800,
          quantity: 2,
          amountFen: 30000,
        }),
        line({ index: 1, skuId: 2, quantity: 2, amountFen: 20000 }),
      ],
      [template()],
      { freeThresholdFen: 49900 },
    );
    expect(result.totalFen).toBe(0);
    expect(result.perLine).toEqual([0, 0]);
  });

  it('leaves the postage alone when the threshold is not reached', () => {
    const result = quote([line({ mode: 'fixed', fixedFreightFen: 800, amountFen: 10000 })], [], {
      freeThresholdFen: 49900,
    });
    expect(result.totalFen).toBe(800);
  });

  it('ships a line whose template has gone missing rather than crashing checkout', () => {
    expect(quote([line({ templateId: 999 })], [template()]).totalFen).toBe(0);
  });
});
