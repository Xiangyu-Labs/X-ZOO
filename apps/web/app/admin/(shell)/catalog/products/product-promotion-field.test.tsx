import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProductPromotionInput } from '@shop/contracts/catalog/promotion';
import { renderAdmin } from '@/test/render';
import { withStubAssets } from '@/test/asset-source';
import { ProductPromotionField } from './product-promotion-field';

const skus = [
  {
    specValues: { 颜色: '白' },
    price: '69.00',
    stock: 10,
    isVisible: true,
    isDefault: true,
    sortOrder: 0,
  },
  {
    specValues: { 颜色: '黑' },
    price: '79.00',
    stock: 12,
    isVisible: true,
    isDefault: false,
    sortOrder: 1,
  },
];
function Harness({
  canPresale = true,
  canGroupbuy = true,
  initial = { mode: 'normal', expectedVersion: 0 } as ProductPromotionInput,
}) {
  const [value, setValue] = useState(initial);
  return (
    <ProductPromotionField
      value={value}
      onChange={setValue}
      skus={skus}
      disabled={false}
      canPresale={canPresale}
      canGroupbuy={canGroupbuy}
      shippingOptions={[]}
    />
  );
}

describe('product sale mode field', () => {
  it('selects presale or groupbuy exclusively and shows only the selected fields', async () => {
    renderAdmin(withStubAssets(<Harness />));
    await userEvent.click(screen.getByRole('switch', { name: '是否为预售商品' }));
    expect(screen.getByRole('switch', { name: '是否为预售商品' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('switch', { name: '是否为拼单商品' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByLabelText('付款后发货天数')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: '是否为拼单商品' }));
    expect(screen.getByRole('switch', { name: '是否为预售商品' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: '是否为拼单商品' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByLabelText('付款后发货天数')).toBeNull();
    expect(screen.getByLabelText('成团总人数')).toBeInTheDocument();
  });

  it('batch-fills per-spec decimal prices without changing the single-buy price', async () => {
    renderAdmin(withStubAssets(<Harness />));
    await userEvent.click(screen.getByRole('switch', { name: '是否为预售商品' }));
    await userEvent.type(screen.getByLabelText('批量预售价'), '49');
    await userEvent.click(screen.getByRole('button', { name: '批量填写预售价' }));
    expect(screen.getByLabelText('白预售价')).toHaveValue('49.00');
    expect(screen.getByLabelText('黑预售价')).toHaveValue('49.00');
    expect(screen.getByText('¥69.00')).toBeInTheDocument();
    expect(screen.getByText('¥79.00')).toBeInTheDocument();
  });

  it('disables campaign writes for an operator without the corresponding atoms', () => {
    renderAdmin(withStubAssets(<Harness canPresale={false} canGroupbuy={false} />));
    expect(screen.getByRole('switch', { name: '是否为预售商品' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: '是否为拼单商品' })).toBeDisabled();
  });
});
