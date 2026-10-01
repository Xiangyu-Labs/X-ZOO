import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, H5_BUTTON_ROLE, buttonClassName } from './button';

describe('Button', () => {
  it('calls onClick and carries its look as classes', () => {
    const onClick = vi.fn();
    render(
      <Button variant="secondary" size="lg" block onClick={onClick}>
        立即购买
      </Button>,
    );
    const button = screen.getByRole('button', { name: '立即购买' });
    expect(button.className).toBe('shop-btn shop-btn--secondary shop-btn--lg shop-btn--block');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores taps while loading or disabled, and says so', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading onClick={onClick}>
        提交订单
      </Button>,
    );
    const button = screen.getByRole('button', { name: '提交订单' });
    expect(button.className).toContain('shop-btn--loading');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    rerender(
      <Button disabled onClick={onClick}>
        提交订单
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: '提交订单' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('stays busy until a returned promise settles, dropping a second tap in the same tick', async () => {
    let finish: () => void = () => undefined;
    const onClick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => resolve();
        }),
    );
    render(<Button onClick={onClick}>保存</Button>);
    const button = screen.getByRole('button', { name: '保存' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.className).toContain('shop-btn--loading');
    expect(button.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(button.className).not.toContain('shop-btn--loading');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is free again after a rejected promise', async () => {
    const onClick = vi.fn(() => Promise.reject(new Error('保存失败')));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Button onClick={onClick}>保存</Button>);
    const button = screen.getByRole('button', { name: '保存' });
    fireEvent.click(button);
    await waitFor(() => expect(button.className).not.toContain('shop-btn--loading'));
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(new Error('保存失败'));
    logged.mockRestore();
  });

  it('passes the contact open-type and its session source', () => {
    render(
      <Button openType="contact" sessionFrom="route:product;id:11">
        客服
      </Button>,
    );
    const button = screen.getByRole('button', { name: '客服' });
    expect(button.dataset['openType']).toBe('contact');
    expect(button.dataset['sessionFrom']).toBe('route:product;id:11');
  });

  it('builds the same classes for platform buttons', () => {
    expect(buttonClassName({})).toBe('shop-btn shop-btn--primary shop-btn--md');
    expect(buttonClassName({ variant: 'danger', size: 'sm', disabled: true })).toBe(
      'shop-btn shop-btn--danger shop-btn--sm shop-btn--disabled',
    );
  });

  it('says it is a button on H5 only, where Taro draws no native one', async () => {
    // WeChat's own <button> has the role: the weapp build adds nothing.
    expect(H5_BUTTON_ROLE).toEqual({});
    vi.stubEnv('TARO_ENV', 'h5');
    try {
      vi.resetModules();
      const h5 = await import('./button');
      expect(h5.H5_BUTTON_ROLE).toEqual({ role: 'button' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
