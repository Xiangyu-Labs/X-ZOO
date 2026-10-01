import { Button } from '@tarojs/components';
import { fetchTransport } from '@shop/api-client';
import { generatedAvatar, pickImages, uploadWithFetch } from './h5-files';
import type {
  AvatarButtonProps,
  ChosenAddress,
  MiniPlatform,
  OrderConfirmOutcome,
  PaymentOutcome,
  PhoneNumberButtonProps,
  SubscribeResult,
} from './types';
import type { WechatInvoiceTitle } from './invoice-title-map';
import { needPrivacyAuthorization, type PrivacyApi } from './privacy';

/**
 * "模拟小程序" (plan §1): the H5 build behaving, towards the server, exactly like the
 * mini-program. Built only by `build:h5:mp-emulation`, served only by the e2e harness
 * (`e2e/storefront`, `SHOP_E2E_CLIENT=mini`); never part of the WeChat package.
 *
 * - Every request says `X-Client-Platform: wechat-mini`.
 * - `login()` returns a real, single-use `wx.login` code: the harness mints one, teaches it to
 *   the fake `api.weixin.qq.com` (`@shop/testing`'s `startFakeOaServer`) and hands it back, so
 *   the server redeems it through the same `jscode2session` call as in production.
 * - The phone button does the same for `getPhoneNumber` (`getuserphonenumber`).
 * - `requestPayment` asks the harness to settle the transaction on the fake WeChat Pay gateway
 *   and deliver the signed notification to `/api/v1/webhooks/wechat-pay`, which is what WeChat
 *   does after a real payment sheet; the page then polls `payment.status` as it would on a phone.
 * - `openOrderConfirm` (确认收货组件) asks the harness to mark the payment confirmed on the fake
 *   `api.weixin.qq.com`, which the server then reads through `get_order`.
 * - Privacy (C04): with `privacy: 'undecided'` the first private API (the phone, avatar,
 *   address and picture pickers here) raises `onNeedPrivacyAuthorization` as WeChat does, so the
 *   app's own `PrivacySheet` asks; 拒绝 fails that call the way WeChat fails it.
 *
 * Which WeChat user is "holding the phone" is test data: the harness writes it to
 * `localStorage[EMULATION_STORAGE_KEY]` before the app starts. Without one, a random user is
 * made up and kept, so a developer can click through by hand.
 *
 * The harness endpoints live under `/__e2e/mini/` on the page's own origin (the e2e edge
 * forwards them to `e2e/storefront/src/gateway-control.ts`). `scripts/size-report.mjs` fails
 * the WeChat build if that prefix or this file's storage key ever appears in it.
 */

export const EMULATION_STORAGE_KEY = '__shop_mp_emulation__';
const CONTROL_PREFIX = '/__e2e/mini';

export interface EmulatedWechatUser {
  openid: string;
  unionid?: string | undefined;
  /** What `getPhoneNumber` answers: the number without country code. */
  phone: string;
  /** What the shopper does with the payment sheet. Default `pay`. */
  payment?: 'pay' | 'cancel' | 'fail' | undefined;
  /** How the subscribe-message dialog is answered, for every template. Default `accept`. */
  subscribe?: 'accept' | 'reject' | undefined;
  /** What 导入微信地址 returns; `null` = the shopper cancels. Default: a fixed address. */
  address?: ChosenAddress | null | undefined;
  /**
   * How the 确认收货 component ends. Default `confirm`. `confirm-silently`: confirmed in
   * WeChat, but its callback never reaches the app, which only sees itself come back to the
   * foreground (the C07 `onShow` fallback).
   */
  receipt?: 'confirm' | 'cancel' | 'fail' | 'confirm-silently' | undefined;
  /**
   * What 从微信导入 (`chooseInvoiceTitle`) returns, in WeChat's own shape; `null` = the shopper
   * cancels. Default: a fixed company title (`invoice-title.h5.ts`).
   */
  invoiceTitle?: WechatInvoiceTitle | null | undefined;
  /**
   * Whether this WeChat user has agreed to the shop's 用户隐私保护指引. Default `agreed`.
   * `undecided`: the first private API call raises the app's privacy sheet and waits for 同意 or
   * 拒绝, as WeChat holds it; after 同意 no call asks again (kept in `PRIVACY_STORAGE_KEY`, as
   * WeChat remembers it), after 拒绝 the next call asks again.
   */
  privacy?: 'agreed' | 'undecided' | undefined;
}

/** Where the emulated WeChat remembers this user's 同意 (the harness's key is rewritten per load). */
export const PRIVACY_STORAGE_KEY = '__shop_mp_emulation_privacy__';

const DEFAULT_ADDRESS: ChosenAddress = {
  name: '张三',
  phone: '13800138000',
  province: '广东省',
  city: '广州市',
  district: '天河区',
  detail: '体育西路 100 号',
  postCode: '510000',
};

function randomDigits(length: number): string {
  let digits = '';
  while (digits.length < length) digits += Math.floor(Math.random() * 10).toString();
  return digits;
}

/** The WeChat user on this "phone": what the harness set up, or a made-up one, kept. */
export function emulatedUser(): EmulatedWechatUser {
  const raw = window.localStorage.getItem(EMULATION_STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<EmulatedWechatUser>;
    if (typeof parsed.openid === 'string' && typeof parsed.phone === 'string') {
      return parsed as EmulatedWechatUser;
    }
  }
  const made: EmulatedWechatUser = {
    openid: `o_emu_${randomDigits(16)}`,
    phone: `139${randomDigits(8)}`,
  };
  window.localStorage.setItem(EMULATION_STORAGE_KEY, JSON.stringify(made));
  return made;
}

async function control<T>(action: string, body: unknown): Promise<T> {
  const response = await fetch(`${CONTROL_PREFIX}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`模拟小程序：${action} 失败 (${response.status} ${await response.text()})`);
  }
  return (await response.json()) as T;
}

/** `<taro-button-core>` has no implicit role; say it is a button (e2e finds it by role). */
const BUTTON_ROLE = { role: 'button' };

/**
 * WeChat's hold on a private API until the shopper has agreed to the privacy guide: raises
 * `onNeedPrivacyAuthorization` (the app's listener, `needPrivacyAuthorization`) and resolves
 * `true` on 同意, `false` on 拒绝. `exposureAuthorization` only says the sheet is showing.
 */
export function privacyGate(api: PrivacyApi): Promise<boolean> {
  if ((emulatedUser().privacy ?? 'agreed') === 'agreed') return Promise.resolve(true);
  if (window.localStorage.getItem(PRIVACY_STORAGE_KEY) === 'agreed') return Promise.resolve(true);
  return new Promise((resolve) => {
    needPrivacyAuthorization(
      (option) => {
        if (option.event === 'agree') {
          window.localStorage.setItem(PRIVACY_STORAGE_KEY, 'agreed');
          resolve(true);
        } else if (option.event === 'disagree') {
          resolve(false);
        }
      },
      { referrer: api },
    );
  });
}

/** What WeChat answers a private API the shopper refused (`errno` 104). */
const privacyRefused = (api: PrivacyApi) => `${api}:fail privacy permission is not authorized`;

function PhoneNumberButton({ children, className, disabled, onResult }: PhoneNumberButtonProps) {
  return (
    <Button
      {...BUTTON_ROLE}
      className={className ?? ''}
      disabled={disabled ?? false}
      onClick={async () => {
        if (!(await privacyGate('getPhoneNumber'))) {
          // What the weapp button reports for this errMsg (runtime.tsx): not a denial.
          onResult({ ok: false, reason: 'failed', message: privacyRefused('getPhoneNumber') });
          return;
        }
        const user = emulatedUser();
        control<{ code: string }>('phone-code', { phone: user.phone }).then(
          ({ code }) => onResult({ ok: true, code }),
          (error: unknown) =>
            onResult({
              ok: false,
              reason: 'failed',
              message: error instanceof Error ? error.message : String(error),
            }),
        );
      }}
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
      onClick={async () => {
        if (!(await privacyGate('chooseAvatar'))) {
          onResult({ ok: false, message: privacyRefused('chooseAvatar') });
          return;
        }
        onResult(await generatedAvatar());
      }}
    >
      {children}
    </Button>
  );
}

export const emulationPlatform: MiniPlatform = {
  kind: 'h5-mp-emulation',
  api: { baseUrl: '', transport: fetchTransport(), clientPlatform: 'wechat-mini' },
  async login() {
    const user = emulatedUser();
    const { code } = await control<{ code: string }>('login-code', {
      openid: user.openid,
      unionid: user.unionid,
    });
    return code;
  },
  PhoneNumberButton,
  async requestPayment({ params }): Promise<PaymentOutcome> {
    const behaviour = emulatedUser().payment ?? 'pay';
    if (behaviour === 'cancel') return { kind: 'cancelled' };
    if (behaviour === 'fail') return { kind: 'failed', message: 'requestPayment:fail (模拟)' };
    // Only the package, as on a phone: the harness finds the order by prepay_id.
    await control('request-payment', { package: params.package });
    return { kind: 'paid' };
  },
  requestSubscribe(templateIds) {
    const answer = emulatedUser().subscribe ?? 'accept';
    const result: SubscribeResult = {};
    for (const id of templateIds) result[id] = answer;
    return Promise.resolve(result);
  },
  async chooseAddress() {
    // Refused like cancelled: the weapp build returns `null` for both.
    if (!(await privacyGate('chooseAddress'))) return null;
    const { address } = emulatedUser();
    return address === undefined ? DEFAULT_ADDRESS : address;
  },
  AvatarButton,
  async chooseImages(count) {
    if (!(await privacyGate('chooseMedia'))) throw new Error(privacyRefused('chooseMedia'));
    return pickImages(count);
  },
  uploadFile: uploadWithFetch,
  /**
   * WeChat's 确认收货 page, answered by the test data. Confirming there is between the shopper
   * and WeChat: the harness records it on the fake `api.weixin.qq.com`, whose `get_order` is
   * what the server asks before it believes the page (C07).
   */
  async openOrderConfirm(target): Promise<OrderConfirmOutcome> {
    const behaviour = emulatedUser().receipt ?? 'confirm';
    if (behaviour === 'cancel') return { kind: 'cancelled' };
    if (behaviour === 'fail') return { kind: 'failed', message: 'openBusinessView:fail (模拟)' };
    await control('confirm-receipt', target);
    if (behaviour === 'confirm-silently') {
      // WeChat's page closes and the app is in the foreground again (Taro H5's onAppShow).
      window.dispatchEvent(new Event('visibilitychange'));
      return new Promise<never>(() => undefined);
    }
    return { kind: 'confirmed' };
  },
};
