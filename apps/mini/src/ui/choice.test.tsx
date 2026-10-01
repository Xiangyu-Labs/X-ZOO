import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, Radio, Switch } from './choice';

describe('Checkbox', () => {
  it('toggles and reports its state', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="全选" />);
    const box = screen.getByRole('checkbox', { name: '全选' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows indeterminate as a dash, and ignores taps when disabled', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} indeterminate disabled onChange={onChange} label="全选" />);
    const box = screen.getByRole('checkbox', { name: '全选' });
    expect(box.querySelector('.shop-choice__mark--on')).toBeTruthy();
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Radio', () => {
  it('selects, and a second tap on the chosen one does nothing', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Radio checked={false} onChange={onChange} label="微信支付" />);
    fireEvent.click(screen.getByRole('radio', { name: '微信支付' }));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Radio checked onChange={onChange} label="微信支付" />);
    fireEvent.click(screen.getByRole('radio', { name: '微信支付' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('Switch', () => {
  it('flips, and holds still while loading', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked onChange={onChange} label="消息通知" />);
    const toggle = screen.getByRole('switch', { name: '消息通知' });
    expect(toggle.className).toContain('shop-switch--on');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
    rerender(<Switch checked onChange={onChange} label="消息通知" loading />);
    fireEvent.click(screen.getByRole('switch', { name: '消息通知' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
