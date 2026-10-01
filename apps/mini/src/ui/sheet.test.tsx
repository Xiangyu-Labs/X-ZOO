import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { useOverlayStore } from './overlay-store';
import { Sheet } from './sheet';

describe('Sheet', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('slides in as a named modal dialog, locks the page and unmounts after closing', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet visible onClose={onClose} title="选择规格" footer={<Button>确定</Button>}>
        内容
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: '选择规格' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(useOverlayStore.getState().open).toBe(1);
    act(() => vi.advanceTimersByTime(20));
    expect(dialog.className).toContain('shop-sheet--shown');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Sheet visible={false} onClose={onClose} title="选择规格">
        内容
      </Sheet>,
    );
    expect(useOverlayStore.getState().open).toBe(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens after starting hidden, and reopens after closing', () => {
    const onClose = vi.fn();
    const sheet = (visible: boolean) => (
      <Sheet visible={visible} onClose={onClose} title="选择规格">
        内容
      </Sheet>
    );
    const { rerender } = render(sheet(false));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(sheet(true));
    expect(screen.getByRole('dialog', { name: '选择规格' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole('dialog').className).toContain('shop-sheet--shown');
    rerender(sheet(false));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(sheet(true));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes from the mask unless the choice must be made', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <Sheet visible onClose={onClose}>
        x
      </Sheet>,
    );
    fireEvent.click(container.querySelector('.shop-mask') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Sheet visible onClose={onClose} dismissible={false} closable={false}>
        x
      </Sheet>,
    );
    fireEvent.click(container.querySelector('.shop-mask') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  });
});
