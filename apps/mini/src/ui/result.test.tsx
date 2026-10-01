import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { Result } from './result';

describe('Result', () => {
  it('shows the status, a heading, the description and the buttons', () => {
    const { container } = render(
      <Result
        status="success"
        title="支付成功"
        description="实付 ¥45.00"
        actions={<Button>查看订单</Button>}
      />,
    );
    expect(container.firstElementChild?.className).toContain('shop-result--success');
    expect(screen.getByRole('heading').textContent).toBe('支付成功');
    expect(screen.getByText('实付 ¥45.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看订单' })).toBeTruthy();
  });

  it.each(['pending', 'fail', 'waiting'] as const)('has a %s look', (status) => {
    const { container } = render(<Result status={status} title="t" />);
    expect(container.firstElementChild?.className).toContain(`shop-result--${status}`);
  });
});
