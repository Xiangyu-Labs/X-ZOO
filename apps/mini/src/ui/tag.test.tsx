import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, Divider, Tag } from './tag';

describe('Tag', () => {
  it('carries its tone, variant and size as classes', () => {
    render(
      <Tag tone="warning" variant="outline" size="md">
        预售
      </Tag>,
    );
    const tag = screen.getByText('预售').parentElement;
    expect(tag?.className).toBe('shop-tag shop-tag--warning shop-tag--outline shop-tag--md');
  });
});

describe('Badge', () => {
  it('shows the count, capped at max', () => {
    const { rerender } = render(<Badge count={7} />);
    expect(screen.getByLabelText('7 条').textContent).toBe('7');
    rerender(<Badge count={120} />);
    expect(screen.getByLabelText('99+ 条').textContent).toBe('99+');
  });

  it('is a dot without a count, and gone at zero', () => {
    const { container, rerender } = render(<Badge />);
    expect(screen.getByLabelText('有新消息').className).toContain('shop-badge--dot');
    rerender(<Badge count={0} />);
    expect(container.textContent).toBe('');
  });

  it('sits on the corner of what it wraps', () => {
    render(
      <Badge count={3}>
        <span>icon</span>
      </Badge>,
    );
    const bubble = screen.getByLabelText('3 条');
    expect(bubble.className).toContain('shop-badge--corner');
    expect(bubble.parentElement?.className).toContain('shop-badge-host');
  });
});

describe('Divider', () => {
  it('is a line, or a line with words', () => {
    const { container, rerender } = render(<Divider />);
    expect(container.firstElementChild?.className).toBe('shop-divider');
    rerender(<Divider>没有更多了</Divider>);
    expect(container.firstElementChild?.className).toContain('shop-divider--text');
    expect(screen.getByText('没有更多了')).toBeTruthy();
  });
});
