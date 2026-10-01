import { describe, expect, it } from 'vitest';
import {
  initialSelection,
  missingSpecs,
  quantityBounds,
  selectedSku,
  selectionText,
  toggleValue,
  valueState,
  type SkuMatrix,
} from './sku-select';

const sku = (id: string, color: string, size: string, stock: number, price = '59.00') => ({
  id,
  skuCode: `S${id}`,
  specText: `${color}|${size}`,
  specValues: { 颜色: color, 尺码: size },
  imageUrl: null,
  price,
  originalPrice: null,
  stock,
  weight: null,
  volume: null,
});

const matrix: SkuMatrix = {
  specs: [
    {
      name: '颜色',
      values: [
        { value: '白', imageUrl: null },
        { value: '黑', imageUrl: null },
      ],
    },
    {
      name: '尺码',
      values: [
        { value: 'M', imageUrl: null },
        { value: 'L', imageUrl: null },
      ],
    },
  ],
  skus: [
    sku('1', '白', 'M', 5),
    sku('2', '白', 'L', 0),
    sku('3', '黑', 'M', 2),
    sku('4', '黑', 'L', 1, '65.00'),
  ],
};

describe('SKU selection', () => {
  it('starts with nothing picked when every spec has a choice', () => {
    expect(initialSelection(matrix)).toEqual({});
    expect(missingSpecs(matrix, {})).toEqual(['颜色', '尺码']);
    expect(selectionText(matrix, {})).toBe('请选择 颜色 尺码');
    expect(selectedSku(matrix, {})).toBeNull();
  });

  it('starts from a cart row’s SKU when it is in stock', () => {
    expect(initialSelection(matrix, '3')).toEqual({ 颜色: '黑', 尺码: 'M' });
    expect(initialSelection(matrix, '2')).toEqual({});
  });

  it('greys out a value no SKU in stock has with the other picks', () => {
    const picked = { 颜色: '白' };
    expect(valueState(matrix, picked, '尺码', 'M')).toBe('available');
    expect(valueState(matrix, picked, '尺码', 'L')).toBe('sold-out');
    expect(valueState(matrix, picked, '颜色', '白')).toBe('selected');
    expect(valueState(matrix, picked, '颜色', '黑')).toBe('available');
  });

  it('names the SKU once every spec is picked, and unpicks on a second tap', () => {
    const picked = toggleValue(toggleValue({}, '颜色', '黑'), '尺码', 'L');
    expect(selectedSku(matrix, picked)?.id).toBe('4');
    expect(selectionText(matrix, picked)).toBe('已选 黑 / L');
    expect(toggleValue(picked, '尺码', 'L')).toEqual({ 颜色: '黑' });
  });

  it('treats a single-SKU product as chosen', () => {
    const single: SkuMatrix = { specs: [], skus: [sku('9', '', '', 3)] };
    expect(missingSpecs(single, {})).toEqual([]);
    expect(selectedSku(single, {})?.id).toBe('9');
  });

  it('bounds the quantity by stock and 限购', () => {
    const chosen = matrix.skus[0]!;
    expect(quantityBounds(chosen, {})).toEqual({ min: 1, max: 5 });
    expect(
      quantityBounds(chosen, {
        minPurchaseQuantity: 2,
        purchaseLimitMode: 'per_order',
        purchaseLimitQuantity: 3,
      }),
    ).toEqual({ min: 2, max: 3 });
    expect(quantityBounds(null, {}).max).toBe(9999);
  });
});
