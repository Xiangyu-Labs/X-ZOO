import Taro from '@tarojs/taro';

/**
 * WeChat's native toast, loading and modal (design.md §4.2: one toast at a time, 1.5 s,
 * success is text only). Pages use `@/ui`'s `toast` / `confirm`, which call these.
 */
export function showToast(title: string, durationMs = 1500): void {
  void Taro.showToast({ title, icon: 'none', duration: durationMs }).catch(() => undefined);
}

export function showLoading(title = '加载中'): void {
  void Taro.showLoading({ title, mask: true }).catch(() => undefined);
}

export function hideLoading(): void {
  void Promise.resolve(Taro.hideLoading()).catch(() => undefined);
}

export interface ModalOptions {
  title?: string | undefined;
  content: string;
  confirmText?: string | undefined;
  cancelText?: string | undefined;
  /** A destructive step: the confirm button in the danger colour. */
  danger?: boolean | undefined;
  showCancel?: boolean | undefined;
}

/** `wx.showModal`: resolves `true` for the confirm button. */
export async function showModal(options: ModalOptions): Promise<boolean> {
  try {
    const result = await Taro.showModal({
      title: options.title ?? '',
      content: options.content,
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      showCancel: options.showCancel ?? true,
      cancelColor: '#666666',
      // `#RRGGBB` only (WeChat): the literal twins of --color-text-secondary / --color-danger.
      ...(options.danger ? { confirmColor: '#D32F2F' } : {}),
    });
    return result.confirm;
  } catch {
    return false;
  }
}
