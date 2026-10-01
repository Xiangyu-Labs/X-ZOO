import Taro from '@tarojs/taro';

type Unsubscribe = () => void;

/**
 * App foreground/background. In a mini-program the "window" never loses focus the way a
 * browser tab does; the app being shown or hidden is the closest equivalent.
 */
export function onAppVisibility(listener: (visible: boolean) => void): Unsubscribe {
  const show = () => listener(true);
  const hide = () => listener(false);
  Taro.onAppShow(show);
  Taro.onAppHide(hide);
  return () => {
    Taro.offAppShow(show);
    Taro.offAppHide(hide);
  };
}

/** What WeChat passes `onAppShow`: `referrerInfo` when the shopper comes back from another app. */
export interface AppShowOptions {
  referrerInfo?: { appId?: string; extraData?: Record<string, unknown> } | undefined;
}

/** Every return to the foreground, with its options (the H5 builds pass none that matter). */
export function onAppShown(listener: (options: AppShowOptions) => void): Unsubscribe {
  const show = (options: unknown) =>
    listener(options && typeof options === 'object' ? (options as AppShowOptions) : {});
  Taro.onAppShow(show);
  return () => Taro.offAppShow(show);
}
