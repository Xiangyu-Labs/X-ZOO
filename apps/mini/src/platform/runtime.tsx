import Taro from '@tarojs/taro';
import { Button } from '@tarojs/components';
import { taroTransport } from '@shop/api-client';
import type {
  AvatarButtonProps,
  ChosenAddress,
  MiniPlatform,
  OrderConfirmOutcome,
  OrderConfirmTarget,
  PaymentOutcome,
  PhoneNumberButtonProps,
  SubscribeResult,
} from './types';
import { isPrivacyRefusal, isPrivacyUndeclared, PRIVACY_UNDECLARED_PHONE } from './privacy';

/**
 * The WeChat mini-program: the real `wx.*` APIs through Taro. This is the default module for
 * `./runtime`; an H5 build resolves `runtime.h5.tsx` instead (see `types.ts`).
 */

/** `requestPayment:fail cancel` is the shopper closing the sheet, not an error. */
function isCancel(error: unknown): boolean {
  const message = (error as { errMsg?: unknown } | null)?.errMsg;
  return typeof message === 'string' && /cancel/i.test(message);
}

function errMsg(error: unknown): string {
  const message = (error as { errMsg?: unknown } | null)?.errMsg;
  return typeof message === 'string' ? message : String(error);
}

/**
 * WeChat's `errMsg` is English (`requestPayment:fail …`) and means nothing to a shopper, so every
 * `failed` outcome carries a Chinese line instead. The raw text goes to the console, which is
 * what a bug report from 真机调试 / vConsole shows.
 */
function failedWith(message: string, error: unknown): string {
  console.warn(message, errMsg(error));
  return message;
}

const PAYMENT_FAILED = '支付没有完成，请稍后重试';
const RECEIPT_FAILED = '确认收货失败，请稍后重试';
const PHONE_FAILED = '暂时无法获取手机号，请使用短信验证码';
const AVATAR_FAILED = '头像没有选好，请重试';
const AVATAR_PRIVACY = '未同意隐私保护指引，无法设置头像';

function PhoneNumberButton({ children, className, disabled, onResult }: PhoneNumberButtonProps) {
  return (
    <Button
      className={className ?? ''}
      disabled={disabled ?? false}
      openType="getPhoneNumber"
      onGetPhoneNumber={(event) => {
        const { code, errMsg: message } = event.detail as { code?: string; errMsg: string };
        const errno = (event.detail as { errno?: number }).errno;
        if (code) onResult({ ok: true, code });
        else if (isPrivacyUndeclared({ errno, errMsg: message }))
          // The shop's setup, not the shopper's refusal: 公众平台's 用户隐私保护指引 lacks 手机号.
          onResult({ ok: false, reason: 'unavailable', message: PRIVACY_UNDECLARED_PHONE });
        else if (errno === 1400001 || /1400001/.test(message))
          onResult({
            ok: false,
            reason: 'unavailable',
            message: '暂时无法获取手机号，请使用短信验证码登录',
          });
        else if (/deny|cancel/i.test(message))
          onResult({ ok: false, reason: 'denied', message: '已取消授权' });
        // Left as WeChat worded it: each caller matches it with `isPrivacyRefusal` and says what
        // else that page offers (SMS login, another number); it never reaches the screen as is.
        else if (isPrivacyRefusal({ errno, errMsg: message }))
          onResult({ ok: false, reason: 'failed', message });
        else
          onResult({
            ok: false,
            reason: 'failed',
            message: failedWith(PHONE_FAILED, event.detail),
          });
      }}
    >
      {children}
    </Button>
  );
}

function AvatarButton({ children, className, label, onResult }: AvatarButtonProps) {
  return (
    <Button
      className={className ?? ''}
      openType="chooseAvatar"
      {...(label ? { ariaLabel: label } : {})}
      onChooseAvatar={(event) => {
        const { avatarUrl, errMsg: message } = event.detail as {
          avatarUrl?: string;
          errMsg?: string;
        };
        if (avatarUrl) onResult({ ok: true, tempPath: avatarUrl });
        // Closing the picker is not an error: an empty message shows no toast.
        else if (message && /cancel/i.test(message)) onResult({ ok: false, message: '' });
        else if (isPrivacyRefusal(event.detail)) onResult({ ok: false, message: AVATAR_PRIVACY });
        else onResult({ ok: false, message: failedWith(AVATAR_FAILED, event.detail) });
      }}
    >
      {children}
    </Button>
  );
}

const SUBSCRIBE_ANSWERS = new Set(['accept', 'reject', 'ban', 'filter']);

/** The component wants WeChat's own snake_case keys. */
function orderConfirmExtraData(target: OrderConfirmTarget): Record<string, string> {
  return 'transactionId' in target
    ? { transaction_id: target.transactionId }
    : { merchant_id: target.merchantId, merchant_trade_no: target.merchantTradeNo };
}

export const platform: MiniPlatform = {
  kind: 'weapp',
  api: {
    // The shop's https origin; it must also be a 服务器域名 (request 合法域名) in the WeChat
    // console. Set it in `.env.production.local` (gitignored), see docs/mini/spikes/S4-e2e.md.
    baseUrl: process.env.TARO_APP_API_ORIGIN,
    transport: taroTransport(Taro.request),
    clientPlatform: 'wechat-mini',
  },
  async login() {
    const { code } = await Taro.login();
    if (!code) throw new Error('微信登录没有完成，请重试');
    return code;
  },
  PhoneNumberButton,
  async requestPayment({ params }): Promise<PaymentOutcome> {
    try {
      await Taro.requestPayment({
        timeStamp: params.timeStamp,
        nonceStr: params.nonceStr,
        package: params.package,
        signType: params.signType,
        paySign: params.paySign,
      });
      return { kind: 'paid' };
    } catch (error) {
      if (isCancel(error)) return { kind: 'cancelled' };
      return { kind: 'failed', message: failedWith(PAYMENT_FAILED, error) };
    }
  },
  async requestSubscribe(templateIds) {
    // `entityIds` is required by Taro's types for other platforms; WeChat ignores it.
    const result = (await Taro.requestSubscribeMessage({
      tmplIds: templateIds,
      entityIds: [],
    })) as unknown as Record<string, string>;
    const answers: SubscribeResult = {};
    for (const id of templateIds) {
      const answer = result[id];
      if (answer && SUBSCRIBE_ANSWERS.has(answer)) answers[id] = answer as SubscribeResult[string];
    }
    return answers;
  },
  async chooseAddress(): Promise<ChosenAddress | null> {
    try {
      const address = await Taro.chooseAddress();
      return {
        name: address.userName,
        phone: address.telNumber,
        province: address.provinceName,
        city: address.cityName,
        district: address.countyName,
        detail: address.detailInfo,
        postCode: address.postalCode || null,
      };
    } catch {
      // Cancelled, or refused (privacy / 通讯地址 permission): the caller offers manual entry.
      return null;
    }
  },
  AvatarButton,
  async chooseImages(count) {
    try {
      const result = await Taro.chooseMedia({
        count,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      });
      return result.tempFiles.map((file) => file.tempFilePath);
    } catch (error) {
      if (isCancel(error)) return [];
      // Not `new Error(m, { cause })`: iOS 12 drops the second argument.
      throw Object.assign(new Error(errMsg(error)), { cause: error });
    }
  },
  async uploadFile({ url, filePath, name, headers }) {
    const base = process.env.TARO_APP_API_ORIGIN;
    const result = await Taro.uploadFile({
      url: /^https?:/.test(url) ? url : `${base}${url}`,
      filePath,
      name,
      header: headers,
    });
    return { status: result.statusCode, body: typeof result.data === 'string' ? result.data : '' };
  },
  async openOrderConfirm(target): Promise<OrderConfirmOutcome> {
    try {
      // Taro's option type only lists the 支付分 business types; the call is the same.
      const result = (await Taro.openBusinessView({
        businessType: 'weappOrderConfirm',
        extraData: orderConfirmExtraData(target),
      } as unknown as Parameters<typeof Taro.openBusinessView>[0])) as {
        extraData?: { status?: string };
      };
      const status = result.extraData?.status;
      if (status === 'success') return { kind: 'confirmed' };
      if (status === 'cancel') return { kind: 'cancelled' };
      return { kind: 'failed', message: '微信确认收货未完成' };
    } catch (error) {
      if (isCancel(error)) return { kind: 'cancelled' };
      return { kind: 'failed', message: failedWith(RECEIPT_FAILED, error) };
    }
  },
};
