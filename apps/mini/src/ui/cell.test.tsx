import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Card } from './card';
import { Cell, CellGroup } from './cell';

describe('Card', () => {
  it('has a title row with an extra, and padding by default', () => {
    const { container } = render(
      <Card title="订单信息" extra={<span>全部</span>}>
        内容
      </Card>,
    );
    expect(container.firstElementChild?.className).toBe('shop-card shop-card--padded');
    expect(screen.getByText('订单信息')).toBeTruthy();
    expect(screen.getByText('全部')).toBeTruthy();
  });
});

describe('Cell', () => {
  it('is a link with a chevron when it can be tapped', () => {
    const onClick = vi.fn();
    render(
      <CellGroup title="设置">
        <Cell title="收货地址" value="2 个" onClick={onClick} />
      </CellGroup>,
    );
    const row = screen.getByRole('link', { name: '收货地址' });
    expect(row.querySelector('.shop-cell__arrow')).toBeTruthy();
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('设置')).toBeTruthy();
  });

  it('is plain without onClick, with a required mark and an error', () => {
    render(<Cell title="手机号" required error="请输入正确的手机号" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('*').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('请输入正确的手机号')).toBeTruthy();
  });

  it('does nothing when disabled', () => {
    const onClick = vi.fn();
    render(<Cell title="注销账号" disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole('link', { name: '注销账号' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
