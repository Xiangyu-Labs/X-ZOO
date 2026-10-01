import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Price, splitMoney } from './price';

describe('Price', () => {
  it('splits a money string without turning it into a float', () => {
    expect(splitMoney('199.5')).toEqual(['199', '.50']);
    expect(splitMoney('0.1')).toEqual(['0', '.10']);
    expect(splitMoney('20')).toEqual(['20', '']);
    expect(splitMoney('12345678901234.99')).toEqual(['12345678901234', '.99']);
  });

  it('shows ¥, the whole yuan and the decimals, and is read as a price', () => {
    const { container } = render(<Price value="199.5" />);
    expect(screen.getByRole('text', { name: '价格 199.50 元' })).toBeTruthy();
    expect(container.textContent).toBe('¥199.50');
  });

  it('drops .00 when read aloud, keeps it on screen', () => {
    const { container } = render(<Price value="45.00" />);
    expect(screen.getByRole('text', { name: '价格 45 元' })).toBeTruthy();
    expect(container.textContent).toBe('¥45.00');
  });

  it('is read as 原价 when struck through, with a prefix otherwise', () => {
    render(
      <>
        <Price value="299.00" strike />
        <Price value="99.00" prefix="到手价" />
      </>,
    );
    const strike = screen.getByRole('text', { name: '原价 299 元' });
    expect(strike.className).toContain('shop-price--strike');
    expect(screen.getByRole('text', { name: '到手价 99 元' }).textContent).toBe('到手价¥99.00');
  });
});
