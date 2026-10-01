import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Timeline } from './timeline';

describe('Timeline', () => {
  it('lists the steps newest first and marks the first as current', () => {
    render(
      <Timeline
        items={[
          { key: '2', title: '快件已签收', time: '2026-09-20 10:00' },
          { key: '1', title: '快件已揽收', description: '广州转运中心', time: '2026-09-19 08:00' },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.className).toContain('shop-timeline__item--current');
    expect(items[1]?.className).not.toContain('--current');
    expect(items[0]?.textContent).toContain('快件已签收');
    expect(screen.getByText('广州转运中心')).toBeTruthy();
    // Only the steps above the last are joined by a line.
    expect(document.querySelectorAll('.shop-timeline__line')).toHaveLength(1);
  });
});
