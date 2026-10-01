import type { Ctx } from '../kernel/context';

/**
 * The seam onto the `sms` domain's sender.
 *
 * `core/src/sms/` writes `sms_logs`; this domain only decides *that* an SMS
 * should go out and with which template code and parameters. The port follows
 * the shape `order/ports.ts` established — a slot, a registrar and a `resolve*`
 * that returns `undefined` — because a shop with no SMS account is the normal
 * case, not a broken one.
 *
 * Returning a result object rather than throwing is deliberate and matches the
 * WeChat client: these calls run behind the effects ledger, where a thrown
 * error costs a retry of the *whole* fan-out — including the channels that
 * already succeeded.
 */

export interface SmsSendResult {
  ok: boolean;
  /**
   * Nothing was sent, and trying again will not change that: no provider is
   * configured, or the member has no phone. The channel is then `skipped`.
   */
  skipped?: 'no sms provider registered' | 'user has no phone';
  /** Provider code when it failed; free-form, only for the send log. */
  errorCode?: string;
  errorMessage?: string;
}

export interface SmsPort {
  /**
   * `templateCode` is the provider's own (`SMS_123456`); `params` are exactly
   * the template's variables, rendered, in the template's order — Tencent fills
   * `{1}`, `{2}`… from them positionally, Aliyun by `name`. The implementation
   * resolves the phone number from the user.
   */
  send(
    ctx: Ctx,
    input: {
      userId: number;
      templateCode: string;
      signName?: string;
      params: { name: string; value: string }[];
      notificationCode: string;
    },
  ): Promise<SmsSendResult>;
}

let sms: SmsPort | undefined;

export function registerSmsPort(impl: SmsPort): void {
  sms = impl;
}

/** Installs `impl` unless one is already in place (a test's fake wins over the bootstrap). */
export function registerDefaultSmsPort(impl: SmsPort): void {
  sms ??= impl;
}

/**
 * `undefined` means no SMS port is wired (a test that reset it). A wired port
 * whose shop configured `provider: 'none'` answers `skipped` itself. The channel is then skipped and
 * recorded as skipped, never as failed: parking an effect for a channel the
 * shop deliberately does not use would fill the operator's queue with rows they
 * cannot act on.
 */
export function resolveSmsPort(): SmsPort | undefined {
  return sms;
}

/** Test helper. Never call this from app code. */
export function resetNotificationPorts(): void {
  sms = undefined;
}
