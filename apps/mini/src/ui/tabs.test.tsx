import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from './tabs';

const items = [
  { key: 'all', label: '全部' },
  { key: 'unpaid', label: '待付款', count: 3 },
  { key: 'unshipped', label: '待发货', count: 0 },
] as const;

describe('Tabs', () => {
  it('marks the selected tab and changes on a tap of another', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="all" onChange={onChange} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const all = screen.getByRole('tab', { name: '全部' });
    expect(all.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(all);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '待付款 3' }));
    expect(onChange).toHaveBeenCalledWith('unpaid');
  });

  it('shows a count only when there is one', () => {
    render(<Tabs items={items} value="all" onChange={() => undefined} />);
    expect(screen.getByRole('tab', { name: '待发货' }).textContent).toBe('待发货');
  });

  it('scrolls sideways past four tabs, and can stick to the top', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, label: key }));
    const { container } = render(<Tabs items={many} value="c" onChange={() => undefined} sticky />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('shop-tabs--scroll');
    expect(root.className).toContain('shop-tabs--sticky');
    expect(container.querySelector('#shop-tab-c')).toBeTruthy();
  });
});
