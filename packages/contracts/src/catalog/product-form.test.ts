import { describe, expect, it } from 'vitest';

import { adminUserListQuery, userLabelForm } from '../user/schemas';
import { adminProductForm } from './schemas';

const base = {
  name: '话费充值卡',
  kind: 'virtual_card',
  status: 'on_shelf',
  imageUrl: 'https://example.test/p.png',
  sliderImages: [],
  displaySalesBoost: 0,
  specMode: false,
  specs: [],
  freightMode: 'free',
  purchaseLimitMode: 'none',
  minPurchaseQuantity: 1,
  sortOrder: 0,
  descriptionHtml: '',
  categoryIds: ['1'],
};

const sku = { specValues: {}, price: '30.00', isDefault: true, isVisible: true, sortOrder: 0 };

describe('a 卡密 product in the editor', () => {
  it('accepts the pool the editor was shown, echoed back as stock', () => {
    const parsed = adminProductForm.safeParse({
      ...base,
      skus: [{ ...sku, stock: 3, expectedStock: 3 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a stock the operator typed', () => {
    const typed = adminProductForm.safeParse({
      ...base,
      skus: [{ ...sku, stock: 5, expectedStock: 3 }],
    });
    expect(typed.success).toBe(false);
    const fresh = adminProductForm.safeParse({ ...base, skus: [{ ...sku, stock: 5 }] });
    expect(fresh.success).toBe(false);
    expect(fresh.error?.issues[0]?.message).toContain('卡密');
  });
});

describe('what an API client (MCP, the CLI) sends is trimmed too', () => {
  it('saves 「 T恤 」 as 「T恤」 and refuses a name that is only spaces', () => {
    const parsed = adminProductForm.parse({
      ...base,
      name: '  T恤 ',
      skus: [{ ...sku, stock: 0 }],
    });
    expect(parsed.name).toBe('T恤');
    expect(
      adminProductForm.safeParse({ ...base, name: '   ', skus: [{ ...sku, stock: 0 }] }).success,
    ).toBe(false);
  });

  it('searches for the keyword without the space an input method left behind', () => {
    expect(adminUserListQuery.parse({ keyword: '小明 ' }).keyword).toBe('小明');
    expect(userLabelForm.safeParse({ name: '  ' }).success).toBe(false);
  });
});

describe('起购 and 限购', () => {
  it('refuses 起购 above 限购, a product nobody could buy', () => {
    const limited = { ...base, purchaseLimitMode: 'per_order', skus: [{ ...sku, stock: 0 }] };
    const refused = adminProductForm.safeParse({
      ...limited,
      minPurchaseQuantity: 3,
      purchaseLimitQuantity: 2,
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['minPurchaseQuantity']);
    expect(
      adminProductForm.safeParse({ ...limited, minPurchaseQuantity: 2, purchaseLimitQuantity: 2 })
        .success,
    ).toBe(true);
  });
});
