import Taro from '@tarojs/taro';

/**
 * Small string values kept across launches (the session token). `wx.setStorageSync` in the
 * mini-program, `localStorage` behind Taro's H5 shim. A failure to read is "nothing stored":
 * the worst case is one more silent sign-in.
 */
export const storage = {
  get(key: string): string | null {
    try {
      const value: unknown = Taro.getStorageSync(key);
      return typeof value === 'string' && value !== '' ? value : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      Taro.setStorageSync(key, value);
    } catch {
      // Storage full or unavailable: the session lives in memory for this launch only.
    }
  },
  remove(key: string): void {
    try {
      Taro.removeStorageSync(key);
    } catch {
      // Nothing to do: a stale token is refused by the server and dropped then.
    }
  },
};
