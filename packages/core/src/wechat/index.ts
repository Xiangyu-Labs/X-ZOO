/**
 * The `wechat` domain's public surface.
 *
 * Two clients live here, and they are deliberately separate:
 *
 * | Client            | Host                     | Credentials                | Callers |
 * | ----------------- | ------------------------ | -------------------------- | ------- |
 * | `WechatCoreClient`| `api.weixin.qq.com`      | appid + secret (`wechat`)  | sign-in, notifications, `wechat-oa` |
 * | `WechatPayClient` | `api.mch.weixin.qq.com`  | merchant keys (`payment`)  | `payment` only |
 *
 * `createWechatPayClient` takes its credentials as an argument rather than
 * reading the `payment` config group itself. A core domain may reach another
 * only through that domain's `index.ts`, and `payment` already imports
 * `wechat`; the argument keeps the arrow pointing one way. The payment domain
 * builds the object in `payment/payment.config.ts` (`paymentCredentials`).
 *
 * `wechat.crypto.ts` is exported whole: its functions are pure (v3 signing,
 * AEAD), so anything that has to verify a WeChat Pay signature can use them
 * without building a pay client.
 */

import { registerSiteAuthMethod, wechatMiniConfig, wechatOaConfig } from '../system';
import { wechatConfig } from './wechat.config';
import { registerWechatConfigTest } from './wechat.config-test';
import { registerContentSecurityEffects } from './wechat.sec-check';
import { wechatMiniLoginUsable, wechatOaLoginUsable } from './wechat.site-auth';

export {
  createWechatClient,
  getWechatClient,
  resetWechatTokenFlight,
  type MiniSession,
  type OaCodeExchange,
  type SubscribeMessageInput,
  type TemplateMessageInput,
  type WechatApp,
  type WechatCall,
  type WechatUpload,
  type WechatBytesResult,
  type WechatCoreClient,
  type WechatProfile,
  type WechatSendResult,
} from './wechat.client';

export { wechatConfig, type WechatConfig } from './wechat.config';

/** 「…失败：AppSecret 不正确（错误码 40125）」: WeChat's errcode in words a person reads. */
export { wechatErrcodeHint, wechatRefusal } from './wechat.errcodes';

/** 公众号 / 小程序 sign-in availability, exported for tests. */
export { wechatMiniLoginUsable, wechatOaLoginUsable } from './wechat.site-auth';

/** `GET /api/v1/share/mini-codes` — 小程序码, generated once and cached. */
export { shareMiniCodeUrl } from './wechat.mini-code.service';

/** Read-only; the writes belong to sign-in in the user domain. */
export { findOpenid } from './wechat.repo';

export {
  createWechatPayClient,
  isPaymentConfigured,
  refundEndedMessage,
  refundRefusalMessage,
  REFUND_NO_ANSWER,
  type GatewayRefund,
  type GatewayRefundStatus,
  type GatewayTransaction,
  type PayCreateInput,
  type RefundCreateInput,
  type VerifiedNotification,
  type WechatPayClient,
  type WechatPayCredentials,
  type WechatTradeState,
} from './wechat.pay';

/** 小程序发货信息管理: the port, the driver over `api.weixin.qq.com` and the wire mapping. */
export {
  describeItems,
  isShunfeng,
  maskPhone,
  miniShippingPort,
  registerMiniShippingPort,
  resetMiniShippingPort,
  rfc3339Shanghai,
  SHIPPING_SETTLED_ERRCODES,
  uploadShippingBody,
  wechatMiniShippingDriver,
  type MiniLogisticsType,
  type MiniShippingAnswer,
  type MiniShippingPackage,
  type MiniShippingPort,
  type MiniTradeKey,
  type MiniTradeManagedAnswer,
  type MiniTradeOrderAnswer,
  type MiniUploadShipping,
} from './wechat.shipping';

/** `/api/v1/webhooks/wechat-mini`: the mini program's 消息推送, recorded into the effects ledger. */
export {
  checkText,
  contentSecurityPort,
  listMediaChecks,
  MEDIA_CHECK_EVENT,
  MEDIA_CHECK_SCOPE,
  registerContentSecurityPort,
  registerMediaRiskHandler,
  registerMediaUncheckedHandler,
  requestMediaCheck,
  resetContentSecurityPort,
  wechatContentSecurityDriver,
  type ContentSecurityPort,
  type MediaCheckAnswer,
  type MediaRiskHandler,
  type MediaUncheckedHandler,
  type MediaSubject,
  type MsgSecCheckAnswer,
  type SecCheckScene,
  type SecCheckSuggest,
  type TextVerdict,
} from './wechat.sec-check';
export { contentSecurityConfig, type ContentSecurityConfig } from './wechat.sec-check.config';

export {
  handleMiniPush,
  MINI_PUSH_EVENTS,
  MINI_PUSH_FRESHNESS_SECONDS,
  MINI_PUSH_SCOPE,
  verifyMiniPushUrl,
  type MiniPushEvent,
  type MiniPushMessage,
  type MiniPushResult,
} from './wechat.mini-push';

/** The message-callback envelope, shared by the OA callback and the mini program's push. */
export {
  aesKeyOf,
  decryptMessage,
  encryptMessage,
  equalsSignature,
  signatureOf,
  verifyMessageSignature,
  verifySignature,
  WechatMessageCryptoError,
} from './wechat.message-crypto';

export {
  AeadDecryptError,
  aeadDecrypt,
  buildAuthorization,
  buildJsapiPayParams,
  decryptResource,
  nonceStr,
  requestSignatureMessage,
  safeEqual,
  signatureMessage,
  signWithMerchantKey,
  SIGNATURE_MAX_SKEW_SECONDS,
  VERIFY_FAILURE_MESSAGE,
  verifySignedPayload,
  verifyWithPlatformKey,
  type AuthorizationInput,
  type SignatureHeaders,
  type VerifyFailure,
  type VerifyInput,
  type VerifyResult,
} from './wechat.crypto';

/**
 * Wires the domain into the platform; called once per process from the gen'd
 * bootstrap, like `registerPaymentDomain()`.
 *
 * `GET /api/v1/app/config` tells the app which WeChat sign-in to offer.
 * Announced from here, not read from there: `system` may not import `wechat`.
 * Not run at import, because this module is reached from inside `system`'s own
 * import graph (via `payment`) before `system` has finished evaluating. A
 * boolean crosses the seam, never a credential.
 */
export function registerWechatDomain(): void {
  registerWechatConfigTest();
  // 内容安全 (C09): submit pictures to mediaCheckAsync, act on wxa_media_check.
  registerContentSecurityEffects();
  registerSiteAuthMethod('wechatOa', {
    groups: [wechatOaConfig.group, wechatConfig.group],
    isEnabled: wechatOaLoginUsable,
  });
  registerSiteAuthMethod('wechatMini', {
    groups: [wechatMiniConfig.group, wechatConfig.group],
    isEnabled: wechatMiniLoginUsable,
  });
}
