import { ApiError } from '@shop/api-client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { Empty } from './empty';
import { ErrorBlock, errorKindOf } from './error-block';

const error = (status: number, message = '出错了') => new ApiError({ status, code: 'X', message });

describe('Empty', () => {
  it('shows the drawing, title, help and next step', () => {
    render(
      <Empty
        image="cart"
        title="购物车是空的"
        description="去挑点喜欢的吧"
        actions={<button type="button">去逛逛</button>}
      />,
    );
    expect(screen.getByText('购物车是空的')).toBeTruthy();
    expect(screen.getByText('去挑点喜欢的吧')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去逛逛' })).toBeTruthy();
  });
});

describe('ErrorBlock', () => {
  it('sorts errors into network, not-found, unauthenticated and server', () => {
    expect(errorKindOf(error(0))).toBe('network');
    expect(errorKindOf(error(404))).toBe('not-found');
    expect(errorKindOf(error(401))).toBe('unauthenticated');
    expect(errorKindOf(error(500))).toBe('server');
    expect(errorKindOf(new Error('boom'))).toBe('server');
  });

  it('offers a retry for a network failure', () => {
    const onRetry = vi.fn();
    render(<ErrorBlock error={error(0)} onRetry={onRetry} />);
    expect(screen.getByText('网络不太好')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the server's own message", () => {
    render(<ErrorBlock error={error(422, '商品已下架')} onRetry={() => undefined} />);
    expect(screen.getByText('商品已下架')).toBeTruthy();
  });

  it('sends a shopper home from something that is gone', async () => {
    render(<ErrorBlock error={error(404)} onRetry={() => undefined} />);
    expect(screen.getByText('内容不存在或已下架')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回到首页' }));
    await vi.waitFor(() => expect(taroFake.calls.some((c) => c.api === 'switchTab')).toBe(true));
  });
});
