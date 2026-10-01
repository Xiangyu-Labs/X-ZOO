import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CouponCard, couponValidity, minSpendText, type CouponCardProps } from './coupon-card';

const base: CouponCardProps = {
  title: '满 100 减 10',
  amount: '10.00',
  minSpend: '100.00',
  scope: 'all_products',
  validity: '2026.09.01 - 2026.09.30',
  state: 'claimable',
};

describe('CouponCard', () => {
  it('shows the amount, threshold, scope and dates, and claims', () => {
    const onAction = vi.fn();
    render(<CouponCard {...base} onAction={onAction} />);
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('满 100 可用')).toBeTruthy();
    expect(screen.getByText('全场通用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即领取 满 100 减 10' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('offers 去使用 once claimed, and holds while claiming', () => {
    const { rerender } = render(
      <CouponCard {...base} state="claimable" busy onAction={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: '立即领取 满 100 减 10' }).textContent).toBe(
      '领取中',
    );
    rerender(<CouponCard {...base} state="claimed" onAction={() => undefined} />);
    expect(screen.getByRole('button', { name: '去使用 满 100 减 10' })).toBeTruthy();
  });

  it.each([
    ['sold-out', '已抢光'],
    ['used', '已使用'],
    ['expired', '已过期'],
  ] as const)('stamps a %s coupon', (state, stamp) => {
    const { container } = render(<CouponCard {...base} state={state} onAction={() => undefined} />);
    expect(screen.getByText(stamp)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.firstElementChild?.className).toContain('shop-coupon--dim');
  });

  it('is a radio in the checkout picker, and says why one cannot be used', () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <CouponCard {...base} state="usable" selected={false} onAction={onAction} />,
    );
    const radio = screen.getByRole('radio', { name: '满 100 减 10，满 100 可用，减 10 元' });
    fireEvent.click(radio);
    expect(onAction).toHaveBeenCalledTimes(1);
    rerender(
      <CouponCard
        {...base}
        state="unusable"
        selected={false}
        reason="未达到使用门槛"
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('radio'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('未达到使用门槛')).toBeTruthy();
  });

  it('words the threshold and validity', () => {
    expect(minSpendText('0.00')).toBe('无门槛');
    expect(minSpendText('99.50')).toBe('满 99.50 可用');
    expect(
      couponValidity({
        validFrom: '2026-09-01T00:00:00+08:00',
        validTo: '2026-09-30T23:59:59+08:00',
      }),
    ).toBe('2026.09.01 - 2026.09.30');
    expect(couponValidity({ validFrom: null, validTo: null, validDays: 7 })).toBe(
      '领取后 7 天内有效',
    );
  });
});
