import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CellSkeleton, ProductCardSkeleton, Skeleton, setSkeletonAnimation } from './skeleton';

describe('Skeleton', () => {
  afterEach(() => setSkeletonAnimation(true));

  it('shimmers unless motion is reduced, and is hidden from screen readers', () => {
    const { container, rerender } = render(<Skeleton width="100px" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.className).toContain('shop-skeleton--animated');
    setSkeletonAnimation(false);
    rerender(<Skeleton width="120px" />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain(
      'shop-skeleton--animated',
    );
  });

  it('comes ready-made for product cards and cells', () => {
    const grid = render(<ProductCardSkeleton />);
    expect(grid.container.querySelector('.shop-skeleton-card--grid')).toBeTruthy();
    const list = render(<ProductCardSkeleton layout="list" />);
    expect(list.container.querySelector('.shop-skeleton-card--list')).toBeTruthy();
    const cells = render(<CellSkeleton rows={4} />);
    expect(cells.container.querySelectorAll('.shop-skeleton-cells__row')).toHaveLength(4);
  });
});
