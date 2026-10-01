import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { formatSales, ProductCard, type ProductCardData } from './product-card';

const product: ProductCardData = {
  id: '11',
  name: '有机三只松鼠坚果礼盒',
  subtitle: '每日坚果 30 包',
  imageUrl: '/uploads/p/11.jpg',
  cardImageUrl: null,
  price: '59.90',
  originalPrice: '88.00',
  stock: 12,
  salesDisplay: 12_345,
  labels: [
    {
      id: '1',
      name: '包邮',
      style: 'text',
      fontColor: '#FF0000',
      backgroundColor: null,
      borderColor: null,
      imageUrl: null,
    },
  ],
  canAddToCart: true,
};

describe('ProductCard', () => {
  it('shows the name, price, 划线价, labels and sales, and opens the product', async () => {
    render(<ProductCard product={product} />);
    const card = screen.getByRole('link', { name: '有机三只松鼠坚果礼盒' });
    expect(screen.getByRole('text', { name: '价格 59.90 元' })).toBeTruthy();
    expect(screen.getByRole('text', { name: '原价 88 元' })).toBeTruthy();
    expect(screen.getByText('包邮').style.color).toBe('#FF0000');
    expect(screen.getByText('已售 1.2万')).toBeTruthy();
    fireEvent.click(card);
    await vi.waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/pages/product/index?id=11' },
      }),
    );
  });

  it('strikes no 划线价 at or below the price, and says nothing of 已售 0', () => {
    render(<ProductCard product={{ ...product, originalPrice: '59.90', salesDisplay: 0 }} />);
    expect(screen.queryByRole('text', { name: /原价/ })).toBeNull();
    expect(screen.queryByText(/已售/)).toBeNull();
  });

  it('adds to the cart without opening the product', () => {
    const onAddToCart = vi.fn();
    const onClick = vi.fn();
    render(<ProductCard product={product} onAddToCart={onAddToCart} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '加入购物车 有机三只松鼠坚果礼盒' }));
    expect(onAddToCart).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('veils a sold-out product and hides the cart button', () => {
    render(<ProductCard product={{ ...product, stock: 0 }} onAddToCart={() => undefined} />);
    expect(screen.getByRole('link', { name: '有机三只松鼠坚果礼盒，已售罄' })).toBeTruthy();
    expect(screen.getByText('已售罄')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /加入购物车/ })).toBeNull();
  });

  it('greys an off-shelf product and does nothing on a tap', () => {
    const onClick = vi.fn();
    render(<ProductCard product={product} unavailable onClick={onClick} />);
    const card = screen.getByRole('link', { name: '有机三只松鼠坚果礼盒，已下架' });
    expect(card.className).toContain('shop-product--unavailable');
    fireEvent.click(card);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows an activity tag and price, striking the list price', () => {
    render(<ProductCard product={product} activity="拼团" activityPrice="39.90" layout="list" />);
    expect(screen.getByText('拼团')).toBeTruthy();
    expect(screen.getByRole('text', { name: '价格 39.90 元' })).toBeTruthy();
    expect(screen.getByRole('text', { name: '原价 59.90 元' })).toBeTruthy();
    expect(screen.getByText('每日坚果 30 包')).toBeTruthy();
  });

  it('is compact in a sideways row', () => {
    render(<ProductCard product={product} layout="mini" onAddToCart={() => undefined} />);
    expect(screen.queryByText('已售 1.2万')).toBeNull();
    expect(screen.queryByRole('button', { name: /加入购物车/ })).toBeNull();
  });

  it('writes sales past ten thousand in 万', () => {
    expect(formatSales(999)).toBe('999');
    expect(formatSales(10_000)).toBe('1万');
    expect(formatSales(15_999)).toBe('1.5万');
  });
});
