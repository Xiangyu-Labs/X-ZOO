import { describe, expect, it } from 'vitest';

import { blankSku } from './product-sku-editor';
import { shownPrice } from './product-preview';

describe('the preview’s price', () => {
  it('is the lowest price a shopper can pick, compared in fen', () => {
    expect(
      shownPrice([
        { ...blankSku({ 款式: '粉' }), price: '78.99' },
        { ...blankSku({ 款式: '紫' }), price: '9.90' },
        { ...blankSku({ 款式: '黑' }), price: '1.00', isVisible: false },
        { ...blankSku({ 款式: '白' }), price: '' },
      ]),
    ).toBe('9.90');
  });

  it('is absent while no price is filled in', () => {
    expect(shownPrice([blankSku()])).toBeNull();
  });
});
