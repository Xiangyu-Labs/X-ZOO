import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pressable } from './pressable';

describe('Pressable', () => {
  it('drops a second tap while the promise a tap returned is pending, and takes taps again after', async () => {
    let finish: () => void = () => undefined;
    const onClick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => resolve();
        }),
    );
    render(
      <Pressable label="删除" onClick={onClick}>
        删除
      </Pressable>,
    );
    const row = screen.getByLabelText('删除');
    fireEvent.click(row);
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is free again after a rejected promise', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onClick = vi.fn(() => Promise.reject(new Error('失败')));
    render(
      <Pressable label="领取" onClick={onClick}>
        领取
      </Pressable>,
    );
    const row = screen.getByLabelText('领取');
    fireEvent.click(row);
    await waitFor(() => expect(logged).toHaveBeenCalled());
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it('calls a plain handler on every tap', () => {
    const onClick = vi.fn();
    render(
      <Pressable label="打开" onClick={onClick}>
        打开
      </Pressable>,
    );
    fireEvent.click(screen.getByLabelText('打开'));
    fireEvent.click(screen.getByLabelText('打开'));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
