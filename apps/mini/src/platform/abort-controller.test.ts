import { describe, expect, it, vi } from 'vitest';
import { MiniAbortController } from './abort-controller';

describe('MiniAbortController (the WeChat runtime has no AbortController)', () => {
  it('starts not aborted', () => {
    const { signal } = new MiniAbortController();
    expect(signal.aborted).toBe(false);
    expect(signal.reason).toBeUndefined();
    expect(() => signal.throwIfAborted()).not.toThrow();
  });

  it('aborts once, with an AbortError by default, and tells every listener', () => {
    const controller = new MiniAbortController();
    const listener = vi.fn();
    const onabort = vi.fn();
    controller.signal.addEventListener('abort', listener);
    controller.signal.onabort = onabort;

    controller.abort();
    controller.abort();

    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).name).toBe('AbortError');
    expect(() => controller.signal.throwIfAborted()).toThrow('aborted');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'abort', target: controller.signal });
    expect(onabort).toHaveBeenCalledTimes(1);
  });

  it('keeps the reason it is given', () => {
    const controller = new MiniAbortController();
    const reason = { cancelled: true };
    controller.abort(reason);
    expect(controller.signal.reason).toBe(reason);
  });

  it('drops a removed listener and ignores other event types', () => {
    const controller = new MiniAbortController();
    const removed = vi.fn();
    const other = vi.fn();
    controller.signal.addEventListener('abort', removed, { once: true });
    controller.signal.removeEventListener('abort', removed);
    controller.signal.addEventListener('change', other);
    controller.abort();
    expect(removed).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });
});
