import { describe, expect, it } from 'vitest';
import { adminProductForm, type AdminProductForm } from '@shop/contracts/catalog/schemas';

import {
  ancestorIdsOfPath,
  canAddToCart,
  chargesFreight,
  checkPurchaseLimit,
  childPath,
  comboKey,
  compareDecimal,
  levelOfPath,
  likePattern,
  normaliseKeyword,
  ratingBucket,
  rollupSkus,
  salesDisplay,
  skuCodeFrom,
  skuMatrix,
  specTextOf,
  summariseReviews,
  wouldCycle,
} from './catalog.rules';

describe('skuMatrix', () => {
  it('multiplies the axes in declaration order', () => {
    const rows = skuMatrix([
      { name: '颜色', values: [{ value: '红' }, { value: '蓝' }] },
      { name: '尺码', values: [{ value: 'M' }, { value: 'L' }] },
    ]);

    expect(rows.map((r) => r.specText)).toEqual(['红|M', '红|L', '蓝|M', '蓝|L']);
    expect(rows[0]!.specValues).toEqual({ 颜色: '红', 尺码: 'M' });
  });

  it('keeps the axis order of the input, not alphabetical order', () => {
    // `specText` is a unique index. Sorting the axes would rename every SKU of
    // every product the first time an operator reordered the spec rows.
    const rows = skuMatrix([
      { name: '尺码', values: [{ value: 'M' }] },
      { name: '颜色', values: [{ value: '红' }] },
    ]);
    expect(rows[0]!.specText).toBe('M|红');
  });

  it('handles a single axis', () => {
    const rows = skuMatrix([{ name: '颜色', values: [{ value: '红' }] }]);
    expect(rows).toEqual([{ specValues: { 颜色: '红' }, specText: '红' }]);
  });

  it('returns nothing for no axes — a single-spec product has no matrix', () => {
    expect(skuMatrix([])).toEqual([]);
  });

  it('grows multiplicatively across three axes', () => {
    const rows = skuMatrix([
      { name: 'a', values: [{ value: '1' }, { value: '2' }] },
      { name: 'b', values: [{ value: '3' }, { value: '4' }, { value: '5' }] },
      { name: 'c', values: [{ value: '6' }, { value: '7' }] },
    ]);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.specText)).size).toBe(12);
  });
});

describe('specTextOf', () => {
  it('joins with a pipe in the given axis order', () => {
    expect(specTextOf({ 颜色: '红', 尺码: 'XL' }, ['颜色', '尺码'])).toBe('红|XL');
    expect(specTextOf({ 颜色: '红', 尺码: 'XL' }, ['尺码', '颜色'])).toBe('XL|红');
  });

  it('is the empty string for a single-spec product', () => {
    expect(specTextOf({}, [])).toBe('');
  });

  it('skips an axis the combination does not carry', () => {
    expect(specTextOf({ 颜色: '红' }, ['颜色', '尺码'])).toBe('红');
  });
});

describe('comboKey', () => {
  it('is order-independent, so a reordered editor row still matches its SKU', () => {
    expect(comboKey({ 颜色: '红', 尺码: 'M' })).toBe(comboKey({ 尺码: 'M', 颜色: '红' }));
  });

  it('separates the axis from the value, so 红|M and 红M are different combinations', () => {
    expect(comboKey({ a: 'b|c' })).not.toBe(comboKey({ 'a|b': 'c' }));
  });
});

describe('canAddToCart', () => {
  it('allows a plain physical product', () => {
    expect(canAddToCart({ kind: 'physical', hasCustomForm: false })).toBe(true);
  });

  it.each(['virtual_card', 'virtual_coupon', 'virtual_manual'] as const)(
    'refuses %s — it is bought straight away',
    (kind) => {
      expect(canAddToCart({ kind, hasCustomForm: false })).toBe(false);
    },
  );

  it('refuses a product with a custom form', () => {
    expect(canAddToCart({ kind: 'physical', hasCustomForm: true })).toBe(false);
  });

  it('refuses a presale product, which the presale domain flags', () => {
    expect(canAddToCart({ kind: 'physical', hasCustomForm: false, isPresale: true })).toBe(false);
  });
});

describe('chargesFreight', () => {
  it('is true only for physical goods', () => {
    expect(chargesFreight('physical')).toBe(true);
    expect(chargesFreight('virtual_manual')).toBe(false);
  });
});

describe('salesDisplay', () => {
  it('adds the padding', () => {
    expect(salesDisplay(41, 100)).toBe(141);
  });

  it('never goes negative on bad data', () => {
    expect(salesDisplay(-5, -5)).toBe(0);
  });
});

describe('checkPurchaseLimit', () => {
  it('refuses below the minimum quantity', () => {
    const verdict = checkPurchaseLimit({
      mode: 'none',
      limitQuantity: null,
      minQuantity: 2,
      requested: 1,
      alreadyBought: 0,
    });
    expect(verdict).toEqual({ ok: false, reason: 'below-minimum', remaining: null });
  });

  it('allows anything when there is no limit', () => {
    expect(
      checkPurchaseLimit({
        mode: 'none',
        limitQuantity: null,
        minQuantity: 1,
        requested: 99,
        alreadyBought: 40,
      }),
    ).toEqual({ ok: true, reason: null, remaining: null });
  });

  it('ignores past purchases for a per-order limit', () => {
    expect(
      checkPurchaseLimit({
        mode: 'per_order',
        limitQuantity: 5,
        minQuantity: 1,
        requested: 5,
        alreadyBought: 100,
      }),
    ).toEqual({ ok: true, reason: null, remaining: 0 });
  });

  it('refuses one over a per-order limit', () => {
    expect(
      checkPurchaseLimit({
        mode: 'per_order',
        limitQuantity: 5,
        minQuantity: 1,
        requested: 6,
        alreadyBought: 0,
      }),
    ).toEqual({ ok: false, reason: 'limit-reached', remaining: 5 });
  });

  it('counts past purchases for a lifetime limit', () => {
    expect(
      checkPurchaseLimit({
        mode: 'lifetime',
        limitQuantity: 3,
        minQuantity: 1,
        requested: 2,
        alreadyBought: 1,
      }),
    ).toEqual({ ok: true, reason: null, remaining: 0 });
  });

  it('refuses a second unit at a lifetime limit of one', () => {
    // `>= limit` in one place and `> limit` in another is how a lifetime limit
    // of 1 sometimes let two through.
    expect(
      checkPurchaseLimit({
        mode: 'lifetime',
        limitQuantity: 1,
        minQuantity: 1,
        requested: 1,
        alreadyBought: 1,
      }),
    ).toEqual({ ok: false, reason: 'limit-reached', remaining: 0 });
  });
});

describe('category paths', () => {
  it('gives a root category the path /', () => {
    expect(childPath(null)).toBe('/');
    expect(levelOfPath('/')).toBe(0);
  });

  it('appends the parent id', () => {
    expect(childPath({ id: 7, path: '/' })).toBe('/7/');
    expect(childPath({ id: 17, path: '/7/' })).toBe('/7/17/');
    expect(levelOfPath('/7/17/')).toBe(2);
  });

  it('reads the ancestors back out, outermost first', () => {
    expect(ancestorIdsOfPath('/7/17/')).toEqual([7, 17]);
    expect(ancestorIdsOfPath('/')).toEqual([]);
  });
});

describe('wouldCycle', () => {
  const category = { categoryId: 7, categoryPath: '/' };

  it('allows a move to the root', () => {
    expect(wouldCycle({ ...category, newParent: null })).toBe(false);
  });

  it('refuses making a category its own parent', () => {
    expect(wouldCycle({ ...category, newParent: { id: 7, path: '/' } })).toBe(true);
  });

  it('refuses a move under its own child', () => {
    expect(wouldCycle({ ...category, newParent: { id: 17, path: '/7/' } })).toBe(true);
  });

  it('refuses a move under a grandchild', () => {
    expect(wouldCycle({ ...category, newParent: { id: 33, path: '/7/17/' } })).toBe(true);
  });

  it('allows a move under an unrelated branch', () => {
    expect(
      wouldCycle({ categoryId: 17, categoryPath: '/7/', newParent: { id: 9, path: '/' } }),
    ).toBe(false);
  });

  it('is not fooled by a prefix that is not a path segment', () => {
    // `/7/` must not look like an ancestor of `/70/`.
    expect(wouldCycle({ categoryId: 7, categoryPath: '/', newParent: { id: 70, path: '/' } })).toBe(
      false,
    );
  });
});

describe('ratingBucket', () => {
  it('groups 4 and 5 as good, 3 as medium, 1 and 2 as bad', () => {
    expect([1, 2, 3, 4, 5].map(ratingBucket)).toEqual(['bad', 'bad', 'medium', 'good', 'good']);
  });
});

describe('summariseReviews', () => {
  it('averages to one decimal and rounds the rate to a whole percent', () => {
    expect(
      summariseReviews({ total: 18, good: 16, medium: 1, bad: 1, withImages: 7, scoreSum: 83 }),
    ).toEqual({
      total: 18,
      goodCount: 16,
      mediumCount: 1,
      badCount: 1,
      withImagesCount: 7,
      averageScore: 4.6,
      goodRate: 89,
    });
  });

  it('opens a brand new product at 100% rather than 0%', () => {
    const summary = summariseReviews({
      total: 0,
      good: 0,
      medium: 0,
      bad: 0,
      withImages: 0,
      scoreSum: 0,
    });
    expect(summary.goodRate).toBe(100);
    expect(summary.averageScore).toBe(0);
  });

  it('does not divide by a negative total', () => {
    expect(
      summariseReviews({ total: -3, good: 0, medium: 0, bad: 0, withImages: 0, scoreSum: 0 }).total,
    ).toBe(0);
  });
});

describe('search keyword handling', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseKeyword('  白 T   恤 ')).toBe('白 T 恤');
  });

  it('caps the length so a pasted essay cannot reach the index', () => {
    expect(normaliseKeyword('阿'.repeat(200))).toHaveLength(64);
  });

  it('escapes LIKE wildcards so 100%纯棉 is a search, not a match-all', () => {
    expect(likePattern('100%纯棉')).toBe('%100\\%纯棉%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('skuCodeFrom', () => {
  it('is prefixed, alphanumeric and free of lookalike characters', () => {
    const code = skuCodeFrom(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code.startsWith('SKU')).toBe(true);
    expect(code).toMatch(/^SKU[A-HJ-NP-Z2-9]+$/);
    expect(code).not.toMatch(/[01IO]/);
  });

  it('stays inside varchar(32)', () => {
    expect(skuCodeFrom(new Uint8Array(64)).length).toBeLessThanOrEqual(32);
  });

  it('is deterministic in the bytes it is given', () => {
    const bytes = Uint8Array.from([9, 9, 9]);
    expect(skuCodeFrom(bytes)).toBe(skuCodeFrom(bytes));
  });
});

describe('compareDecimal', () => {
  it('orders by magnitude, not by string length alone', () => {
    expect(compareDecimal('9.00', '10.00')).toBe(-1);
    expect(compareDecimal('10.00', '9.00')).toBe(1);
    expect(compareDecimal('10.00', '10.00')).toBe(0);
  });

  it('compares the fraction exactly', () => {
    expect(compareDecimal('10.05', '10.10')).toBe(-1);
    expect(compareDecimal('0.10', '0.1')).toBe(0);
  });
});

describe('rollupSkus', () => {
  const sku = (over: Partial<Parameters<typeof rollupSkus>[0][number]>) => ({
    price: '59.00',
    cost: '22.00',
    stock: 10,
    isVisible: true,
    ...over,
  });

  it('takes the cheapest price and the sum of the stock', () => {
    expect(
      rollupSkus([sku({ price: '59.00', stock: 120 }), sku({ price: '49.00', stock: 4 })]),
    ).toEqual({ price: '49.00', cost: '22.00', stock: 124 });
  });

  it('ignores invisible SKUs in all three numbers', () => {
    // Summing every row would let a hidden 1-cent variant set the card price
    // and a hidden sold-out row make a live product look in stock.
    expect(
      rollupSkus([
        sku({ price: '59.00', stock: 10, isVisible: true }),
        sku({ price: '0.01', stock: 999, isVisible: false }),
      ]),
    ).toEqual({ price: '59.00', cost: '22.00', stock: 10 });
  });

  it('reports zero for a product with no visible SKU', () => {
    expect(rollupSkus([sku({ isVisible: false })])).toEqual({
      price: '0.00',
      cost: null,
      stock: 0,
    });
    expect(rollupSkus([])).toEqual({ price: '0.00', cost: null, stock: 0 });
  });

  it('leaves cost null when no visible SKU records one', () => {
    expect(rollupSkus([sku({ cost: null })]).cost).toBeNull();
  });

  it('never lets a negative stock row pull the total down', () => {
    expect(rollupSkus([sku({ stock: 10 }), sku({ stock: -5 })]).stock).toBe(10);
  });
});

/**
 * The cross-field rules on `adminProductForm`.
 *
 * They live in the contract so the browser and the server enforce the same
 * ones, which means they are only tested once — here — rather than twice.
 * Each mirrors either a table CHECK or a rule the storefront depends on.
 */
describe('the product form', () => {
  const base: AdminProductForm = {
    name: '话费充值卡',
    kind: 'virtual_card',
    status: 'draft',
    imageUrl: 'https://cdn.example.com/card.png',
    sliderImages: [],
    displaySalesBoost: 0,
    specMode: false,
    specs: [],
    skus: [
      {
        specValues: {},
        price: '50.00',
        stock: 0,
        isDefault: true,
        isVisible: true,
        sortOrder: 0,
      },
    ],
    freightMode: 'free',
    purchaseLimitMode: 'none',
    minPurchaseQuantity: 1,
    isHot: false,
    isNew: false,
    isBest: false,
    isBenefit: false,
    isRecommended: false,
    sortOrder: 0,
    descriptionHtml: '',
    categoryIds: ['17'],
    labelIds: [],
    protectionIds: [],
    params: [],
    recommendedProductIds: [],
    giftCouponIds: [],
  };

  function messages(form: AdminProductForm): string[] {
    const result = adminProductForm.safeParse(form);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  }

  it('refuses a hand-typed stock on a card product', () => {
    // The card pool is the stock. Kept apart, the two drift, and the shop sells
    // cards that do not exist.
    expect(messages({ ...base, skus: [{ ...base.skus[0]!, stock: 100 }] })).toContain(
      '卡密商品的库存由导入的卡密数量决定，请勿手动填写',
    );
    expect(messages(base)).toEqual([]);
  });

  it('refuses freight on a virtual product', () => {
    expect(messages({ ...base, freightMode: 'fixed', fixedFreight: '8.00' })).toContain(
      '虚拟商品不计算运费',
    );
  });

  it('demands exactly the freight source the mode names', () => {
    const physical: AdminProductForm = { ...base, kind: 'physical', freightMode: 'template' };
    expect(messages(physical)).toContain('请选择运费模板');
    expect(messages({ ...physical, shippingTemplateId: '3' })).toEqual([]);
    expect(messages({ ...physical, shippingTemplateId: '3', fixedFreight: '8.00' })).toContain(
      '当前计费方式不需要固定运费',
    );
  });

  it('pairs a limit mode with a limit quantity, in both directions', () => {
    expect(messages({ ...base, purchaseLimitMode: 'lifetime' })).toContain('请填写限购数量');
    expect(messages({ ...base, purchaseLimitQuantity: 2 })).toContain('不限购时不需要填写限购数量');
  });

  it('holds the spec matrix to its axes', () => {
    const multi: AdminProductForm = {
      ...base,
      kind: 'physical',
      freightMode: 'free',
      specMode: true,
      specs: [{ name: '尺码', values: [{ value: 'M' }, { value: 'XL' }] }],
      skus: [
        { ...base.skus[0]!, specValues: { 尺码: 'M' } },
        { ...base.skus[0]!, specValues: { 尺码: 'XL' }, isDefault: false },
      ],
    };
    expect(messages(multi)).toEqual([]);

    // A row that does not name every axis is not a combination.
    expect(
      messages({ ...multi, skus: [multi.skus[0]!, { ...multi.skus[1]!, specValues: {} }] }),
    ).toContain('规格组合缺少「尺码」');
    // Two rows for one combination would give the shopper a coin flip.
    expect(
      messages({ ...multi, skus: [multi.skus[0]!, { ...multi.skus[0]!, isDefault: false }] }),
    ).toContain('规格组合不能重复');
    // Two defaults would too.
    expect(
      messages({ ...multi, skus: [multi.skus[0]!, { ...multi.skus[1]!, isDefault: true }] }),
    ).toContain('只能有一个默认规格');
    // A single-spec product is exactly one row.
    expect(messages({ ...multi, specMode: false, specs: [] })).toContain(
      '单规格商品只能有一条库存记录',
    );
  });
});
