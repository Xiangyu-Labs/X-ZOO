import { Button } from '@tarojs/components';
import { fetchTransport } from '@shop/api-client';
import { generatedAvatar, pickImages, uploadWithFetch } from './h5-files';
import {
  PlatformUnsupportedError,
  type AvatarButtonProps,
  type MiniPlatform,
  type PhoneNumberButtonProps,
} from './types';

/**
 * The plain H5 build (`build:h5`): the pages in a browser, for the DIY preview. It is not a
 * storefront a shopper can use, so it has no WeChat: sign-in, the phone button and payment
 * all refuse, and the server sees an `h5` client.
 */

/** `<taro-button-core>` has no implicit role; say it is a button (e2e finds it by role). */
const BUTTON_ROLE = { role: 'button' };

function PhoneNumberButton({ children, className, onResult }: PhoneNumberButtonProps) {
  return (
    <Button
      {...BUTTON_ROLE}
      className={className ?? ''}
      onClick={() =>
        onResult({ ok: false, reason: 'failed', message: 'H5 预览不支持微信手机号授权' })
      }
    >
      {children}
    </Button>
  );
}

function AvatarButton({ children, className, onResult }: AvatarButtonProps) {
  return (
    <Button
      {...BUTTON_ROLE}
      className={className ?? ''}
      onClick={() => generatedAvatar().then(onResult)}
    >
      {children}
    </Button>
  );
}

export const previewPlatform: MiniPlatform = {
  kind: 'h5-preview',
  api: { baseUrl: '', transport: fetchTransport(), clientPlatform: 'h5' },
  login: () => Promise.reject(new PlatformUnsupportedError('微信登录', 'h5-preview')),
  PhoneNumberButton,
  requestPayment: () =>
    Promise.resolve({ kind: 'failed', message: 'H5 预览不支持微信支付' } as const),
  requestSubscribe: () => Promise.resolve({}),
  chooseAddress: () => Promise.reject(new PlatformUnsupportedError('导入微信地址', 'h5-preview')),
  AvatarButton,
  chooseImages: pickImages,
  uploadFile: uploadWithFetch,
  openOrderConfirm: () =>
    Promise.resolve({ kind: 'failed', message: 'H5 预览不支持微信确认收货' } as const),
};
