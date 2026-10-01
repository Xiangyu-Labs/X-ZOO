import { hideLoading, showLoading, showModal, showToast } from '@/platform';

/**
 * Toasts (design.md §4.2): WeChat's own, 1.5 s, one at a time (a new one replaces the old).
 * Success is text only; only `loading` shows a spinner, with a mask that blocks taps, and only
 * for steps that must not run twice (pay, submit).
 */
export const toast = {
  text: (message: string): void => showToast(message),
  /** A sentence the shopper has to read, not just notice (two lines): 3 s. */
  long: (message: string): void => showToast(message, 3000),
  success: (message: string): void => showToast(message),
  loading: (message = '加载中'): void => showLoading(message),
  hide: (): void => hideLoading(),
};

export interface ConfirmOptions {
  title?: string | undefined;
  content: string;
  confirmText?: string | undefined;
  cancelText?: string | undefined;
  /** A destructive step (delete, cancel an order): the confirm button turns red. */
  danger?: boolean | undefined;
}

/** 取消 left, 确认 right, as `wx.showModal` lays them out. Resolves `true` on confirm. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return showModal({
    title: options.title ?? '',
    content: options.content,
    confirmText: options.confirmText ?? '确定',
    cancelText: options.cancelText ?? '取消',
    showCancel: true,
    danger: options.danger ?? false,
  });
}

/** One button: something the shopper must read (an alert). */
export function alert(content: string, title = ''): Promise<boolean> {
  return showModal({ title, content, confirmText: '我知道了', showCancel: false });
}
