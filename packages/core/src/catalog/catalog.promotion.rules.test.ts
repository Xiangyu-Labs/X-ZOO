import { describe, expect, it } from 'vitest';
import { adminProductDetailExample } from '@shop/contracts/catalog/schemas';
import { presaleActivityDetailExample } from '@shop/contracts/presale/schemas';
import { productPromotionForm } from './catalog.promotion.rules';

const product = adminProductDetailExample;
const settings = {
  endAt: '2030-12-31T23:59:59+08:00',
  shipAfterDays: 10,
  skus: product.skus.map((sku) => ({ specValues: sku.specValues, price: '29.00' })),
};
const previous = {
  ...presaleActivityDetailExample,
  originalPrice: null,
  imageUrl: null,
  skus: product.skus.map((sku) => ({
    skuId: sku.id,
    specText: sku.specText,
    price: '29.00',
    stock: 4,
    sales: 2,
    quota: 20,
    isEnabled: true,
  })),
};

describe('product promotion defaults', () => {
  it('preserves a deliberately cleared image and original price on partial edits', () => {
    const form = productPromotionForm(
      product,
      settings,
      previous,
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(form.originalPrice).toBeUndefined();
    expect(form.imageUrl).toBeUndefined();
    expect(form.skus.map((sku) => sku.stock)).toEqual(product.skus.map(() => 4));
    expect(form.skus.map((sku) => sku.quota)).toEqual(product.skus.map(() => 20));
  });

  it('clears optional original prices and quotas explicitly without losing live stock', () => {
    const form = productPromotionForm(
      product,
      {
        ...settings,
        originalPrice: null,
        totalQuota: null,
        skus: settings.skus.map((sku) => ({ ...sku, quota: null })),
      },
      { ...previous, originalPrice: '99.00', totalQuota: 50 },
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(form.originalPrice).toBeUndefined();
    expect(form.totalQuota).toBeUndefined();
    expect(form.skus.every((sku) => sku.quota === undefined && sku.stock === 4)).toBe(true);
  });
});
