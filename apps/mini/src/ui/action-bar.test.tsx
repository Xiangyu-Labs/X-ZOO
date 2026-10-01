import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionBar } from './action-bar';
import { Button } from './button';

describe('ActionBar', () => {
  it('has icon entries with a badge, a contact button and the main buttons', () => {
    const toCart = vi.fn();
    render(
      <ActionBar
        icons={[
          { icon: 'service', label: '客服', contact: { sessionFrom: 'route:product;id:11' } },
          { icon: 'cart', label: '购物车', badge: 3, onClick: toCart },
          { icon: 'heart-fill', label: '收藏', active: true, onClick: () => undefined },
        ]}
      >
        <Button variant="secondary">加入购物车</Button>
        <Button>立即购买</Button>
      </ActionBar>,
    );
    const contact = screen.getByRole('button', { name: '客服' });
    expect(contact.dataset['openType']).toBe('contact');
    expect(contact.dataset['sessionFrom']).toBe('route:product;id:11');
    fireEvent.click(screen.getByRole('button', { name: '购物车，3 件' }));
    expect(toCart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '收藏' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '立即购买' })).toBeTruthy();
  });
});
