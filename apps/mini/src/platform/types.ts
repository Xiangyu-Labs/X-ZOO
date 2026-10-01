import type { ComponentType, ReactNode } from 'react';
import type { ClientPlatform, ResponseOf, Transport } from '@shop/api-client';

/**
 * The WeChat capabilities the storefront needs, as one interface with one implementation per
 * build (plan §1, "平台能力"). Pages and features call these; only `src/platform/` calls `Taro.*`.
 *
 * Which implementation a build gets is decided by the bundler, not at run time, so the WeChat
 * package never contains the H5 ones (`scripts/size-report.mjs` scans for them):
 *
 * | Build                                   | Module                  | Implementation                  |
 * | --------------------------------------- | ----------------------- | ------------------------------- |
 * | `build:weapp` (the product)             | `runtime.tsx`           | `Taro.login`, `requestPayment`… |
 * | `build:h5`                              | `runtime.h5.tsx`        | `h5-preview.tsx`: no WeChat     |
 * | `build:h5:mp-emulation` (the e2e suite) | `runtime.h5.tsx`        | `h5-mp-emulation.tsx`           |
 *
 * `runtime.h5.tsx` is picked over `runtime.tsx` by Taro's multi-platform resolution
 * (`MultiPlatformPlugin`, relative imports only) whenever `TARO_ENV` is `h5`, and the mp
 * flavour by `TARO_APP_PLATFORM_EMULATION=mp`, which `config/index.ts` refuses for weapp.
 */

/** What `payment.start` hands the client for `wx.requestPayment`. */
export type JsapiPayParams = NonNullable<ResponseOf<'payment.start'>['jsapi']>;

export interface PaymentRequest {
  /**
   * The merchant order number, from the same `payment.start` answer. `wx.requestPayment` does
   * not need it; the emulation does, to tell the fake gateway which transaction to settle (the
   * fake does not map `prepay_id` back to an order).
   */
  outTradeNo: string;
  params: JsapiPayParams;
}

/**
 * How `requestPayment` ended, as the client sees it. `paid` only means WeChat's sheet said so:
 * the order is paid when `payment.status` says so, which is why every outcome but `cancelled`
 * goes on to the result page and polls (C06).
 */
export type PaymentOutcome =
  { kind: 'paid' } | { kind: 'cancelled' } | { kind: 'failed'; message: string };

/**
 * What a tap on the phone-number button produced. `unavailable`: WeChat will not verify numbers
 * right now (errno 1400001, the shop's quota is used up); offer SMS instead (C05).
 */
export type PhoneCodeResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'denied' | 'unavailable' | 'failed'; message: string };

export interface PhoneNumberButtonProps {
  children: ReactNode;
  className?: string | undefined;
  disabled?: boolean | undefined;
  onResult: (result: PhoneCodeResult) => void;
}

/** What a tap on the avatar button produced: a temporary file to upload. */
export type AvatarResult = { ok: true; tempPath: string } | { ok: false; message: string };

export interface AvatarButtonProps {
  children: ReactNode;
  className?: string | undefined;
  /** What a screen reader says (the button shows only the picture). */
  label?: string | undefined;
  onResult: (result: AvatarResult) => void;
}

export interface UploadRequest {
  url: string;
  /** A temporary file path (`wxfile://…`, or a `blob:` URL on H5). */
  filePath: string;
  /** The multipart field name (`POST /uploads` wants `file`). */
  name: string;
  headers: Record<string, string>;
}

export interface UploadResponse {
  status: number;
  /** The raw body text. */
  body: string;
}

export interface SubscribeResult {
  /** Template id → what the shopper chose. */
  [templateId: string]: 'accept' | 'reject' | 'ban' | 'filter';
}

export interface ChosenAddress {
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  postCode: string | null;
}

/**
 * The payment's identity for WeChat's 确认收货 component (C07): the WeChat Pay transaction id,
 * or the merchant id with our out-trade-no. The server hands it out (H2's
 * `payment.wechatReceipt`); the client passes it on untouched.
 */
export type OrderConfirmTarget =
  { transactionId: string } | { merchantId: string; merchantTradeNo: string };

/**
 * How the 确认收货 component ended. `confirmed` only means WeChat's page said so: the server
 * checks with WeChat (`get_order`) before the order moves (C07).
 */
export type OrderConfirmOutcome =
  { kind: 'confirmed' } | { kind: 'cancelled' } | { kind: 'failed'; message: string };

export interface MiniPlatform {
  /** Which implementation this build carries; shown nowhere, useful in a bug report. */
  readonly kind: 'weapp' | 'h5-preview' | 'h5-mp-emulation';
  /** How `@shop/api-client` talks to `/api/v1` in this build. */
  readonly api: {
    /** `''` for same-origin (H5), the shop's https origin in the mini-program. */
    baseUrl: string;
    transport: Transport;
    /** Sent as `X-Client-Platform`; the server picks the WeChat app and pay channel by it. */
    clientPlatform: ClientPlatform;
  };
  /** `wx.login()`: a single-use code for `POST /auth/sessions/wechat-mini`. */
  login(): Promise<string>;
  /**
   * `<button open-type="getPhoneNumber">`. A component, not a function, because WeChat only
   * hands out a phone code from a tap on its own button.
   */
  PhoneNumberButton: ComponentType<PhoneNumberButtonProps>;
  /** `wx.requestPayment()` with the parameters `payment.start` returned. */
  requestPayment(request: PaymentRequest): Promise<PaymentOutcome>;
  /**
   * `wx.requestSubscribeMessage()` (C08). Only `subscribe()` (platform/subscribe.ts) calls it,
   * synchronously from a tap.
   */
  requestSubscribe(templateIds: string[]): Promise<SubscribeResult>;
  /**
   * `wx.chooseAddress()` (导入微信地址, C04). `null` when the shopper cancelled or refused:
   * the caller falls back to typing the address in.
   */
  chooseAddress(): Promise<ChosenAddress | null>;
  /** `<button open-type="chooseAvatar">`: WeChat's avatar picker (C05). */
  AvatarButton: ComponentType<AvatarButtonProps>;
  /** `wx.chooseMedia()` for pictures: temporary paths, `[]` when cancelled. */
  chooseImages(count: number): Promise<string[]>;
  /** `wx.uploadFile()`: one multipart part. Resolves for every HTTP status. */
  uploadFile(request: UploadRequest): Promise<UploadResponse>;
  /**
   * `wx.openBusinessView({ businessType: 'weappOrderConfirm' })`: WeChat's 确认收货 component
   * (C07). Only `platform/receipt.ts` calls it, from a tap.
   */
  openOrderConfirm(target: OrderConfirmTarget): Promise<OrderConfirmOutcome>;
}

/** Thrown by a capability this build does not have (H5 preview) or does not have yet (TODO). */
export class PlatformUnsupportedError extends Error {
  constructor(capability: string, build: MiniPlatform['kind']) {
    super(`${build} 不支持 ${capability}`);
    this.name = 'PlatformUnsupportedError';
  }
}
