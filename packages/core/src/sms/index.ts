/**
 * The `sms` domain's public surface.
 *
 * | Function                | Caller      | When                                        |
 * | ----------------------- | ----------- | ------------------------------------------- |
 * | `sendVerificationCode`  | `user`      | 发送验证码 on every login / bind flow        |
 * | `verifyCode`            | `user`      | inside the flow that consumes the code       |
 * | `registerSmsSender`     | tests, boot | swap the provider without touching config    |
 *
 * `verifyCode` throws — it is always called inside a user-facing transaction
 * that must not continue — while `SmsSender.send` never throws, because a
 * provider outage is a refusal the caller has to shape into a 502.
 *
 * This domain has **no config group of its own**: the provider credentials and
 * the per-phone budgets are the `system` domain's `sms` group, and the code TTL
 * / attempt budget belong to the login flow, so they live in the `user`
 * domain's `storefront-auth` group and arrive as arguments.
 */
import { registerSiteAuthMethod, smsConfig } from '../system';
import { registerSmsConfigTest } from './sms.config-test';
import { smsSenderUsable } from './sms.service';

export {
  sendVerificationCode,
  verifyCode,
  resolveSender,
  senderFor,
  smsProviderConfigured,
  smsSenderUsable,
} from './sms.service';
export type { SendCodeOptions, SendCodeResult } from './sms.service';

export {
  getSmsSenderOverride,
  nullSmsSender,
  registerSmsSender,
  resetSmsSender,
  type SmsMessage,
  type SmsParam,
  type SmsSender,
  type SmsSendResult,
} from './sms.port';

export { createAliyunSmsSender, type AliyunSmsOptions } from './sms-aliyun';
export { createTencentSmsSender, type TencentSmsOptions } from './sms-tencent';
export { fakeSmsSender, type FakeSmsSender } from './sms.fake';

export {
  CODE_LENGTH,
  codeKey,
  generateCode,
  resendKey,
  resendWaitMs,
  type VerifyOutcome,
} from './verification-code';

/**
 * Wires the domain into the platform; called once per process from the gen'd
 * bootstrap, like `registerPaymentDomain()`.
 *
 * 手机号登录 on `GET /api/v1/app/config` is offered exactly when
 * `resolveSender` would return a sender that can deliver. `system` may not
 * import this domain back, so the probe is handed over rather than looked up.
 */
export function registerSmsDomain(): void {
  registerSiteAuthMethod('phone', { groups: [smsConfig.group], isEnabled: smsSenderUsable });
  registerSmsConfigTest();
}
