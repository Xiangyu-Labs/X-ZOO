import type { Ctx } from '../kernel/context';

/**
 * The SMS provider seam.
 *
 * One method, because that is all the shop does with SMS: hand a template id
 * and its variables to a provider and learn whether it was accepted. Delivery
 * receipts would be a webhook nobody reads.
 *
 * `send` **never throws**. A provider outage must not turn 发送验证码 into a
 * 500 — the caller needs to distinguish "we could not send" (a 502 the shopper
 * can retry) from a bug, and an exception crossing this boundary loses that.
 */

/**
 * One template variable. `name` is what an Aliyun template calls it
 * (`${code}`); Tencent's templates are positional and only the order counts.
 */
export interface SmsParam {
  name: string;
  value: string;
}

export interface SmsMessage {
  /** Mainland mobile number, digits only. */
  phone: string;
  /** The provider's own template id, from the `sms` config group. */
  templateId: string;
  /**
   * Exactly the template's variables, in the template's order, and nothing
   * else: Tencent fills `{1}`, `{2}`… from this list and refuses a send whose
   * count differs from the approved template. Empty for a template with none.
   */
  params: readonly SmsParam[];
  /** An approved 签名 other than the one in 短信设置, for this message only. */
  signName?: string | undefined;
}

export interface SmsSendResult {
  ok: boolean;
  /** Provider-side id, for support tickets. */
  messageId?: string;
  /** The provider's own failure code, e.g. `isv.BUSINESS_LIMIT_CONTROL`. */
  providerCode?: string;
  /** Human-readable reason. Logged, never shown to the shopper. */
  error?: string;
}

export interface SmsSender {
  /** `aliyun`, `tencent`, `fake`. Logged with every send. */
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

/**
 * A sender registered at boot, which wins over whatever the config group says.
 *
 * This exists for these callers and no others: the integration tests, which
 * register `fakeSmsSender()`; `apps/web`'s container when the process was
 * started with `SHOP_FAKE_SMS=1` (the out-of-process e2e server, which logs a
 * `warn` at boot and which no deploy template may set); and a future caller
 * that needs to route SMS through something the config group cannot describe.
 * Production leaves it unset and the provider comes from `sms.provider`.
 */
let override: SmsSender | undefined;

export function registerSmsSender(sender: SmsSender): void {
  override = sender;
}

export function getSmsSenderOverride(): SmsSender | undefined {
  return override;
}

/** Test helper. Never call this from app code. */
export function resetSmsSender(): void {
  override = undefined;
}

/**
 * The sender that answers "no provider configured".
 *
 * It refuses rather than pretending to succeed. A shop with no SMS account
 * cannot send login codes, and the honest failure is a 502 the operator can
 * see in the log — not a silent success that leaves every shopper staring at a
 * code that will never arrive. It is emphatically *not* a development mode
 * that logs the code: that is one environment variable away from being a
 * production authentication bypass.
 */
export const nullSmsSender: SmsSender = {
  name: 'none',
  send: () =>
    Promise.resolve({
      ok: false,
      providerCode: 'NOT_CONFIGURED',
      error: '未配置短信服务商（系统设置 → 短信设置）',
    }),
};

export type SmsSenderFactory = (ctx: Ctx) => Promise<SmsSender>;
