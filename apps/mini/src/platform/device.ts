import Taro from '@tarojs/taro';

/** 拨打电话 (客服热线). A cancel is not an error. */
export function callPhone(phoneNumber: string): void {
  void Promise.resolve(Taro.makePhoneCall({ phoneNumber })).catch(() => undefined);
}

/**
 * Full-screen preview of pictures, starting at `current` (review photos, uploads). The URLs must
 * be absolute: pass an upload's `/uploads/…` path through `assetUrl` first, or the preview opens
 * nothing on a phone.
 */
export function previewImages(urls: readonly string[], current: string): void {
  void Promise.resolve(Taro.previewImage({ urls: [...urls], current })).catch(() => undefined);
}
