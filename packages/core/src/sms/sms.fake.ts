import type { SmsMessage, SmsSendResult, SmsSender } from './sms.port';

/**
 * An in-memory sender for tests and for a staging box with no SMS account.
 *
 * It lives in `core`, next to the port it implements, so `apps/web` can
 * register it without depending on `@shop/testing`. Registering it is an
 * explicit call, never a config value: the tests call it, and so does
 * `apps/web`'s container when the process env says `SHOP_FAKE_SMS=1` — an env
 * var an operator would have to type, not a choice on the 短信设置 screen.
 */

export interface FakeSmsSender extends SmsSender {
  readonly sent: SmsMessage[];
  /** The code of the last message to this number, dug out of `params`. */
  lastCodeFor(phone: string): string | undefined;
  reset(): void;
  /** Make the next `n` sends fail, to exercise the "provider refused" path. */
  failNext(count?: number, result?: Partial<SmsSendResult>): void;
}

export function fakeSmsSender(): FakeSmsSender {
  const sent: SmsMessage[] = [];
  let failures = 0;
  let failureResult: Partial<SmsSendResult> = {};
  let counter = 0;

  return {
    name: 'fake',
    sent,
    send(message) {
      if (failures > 0) {
        failures -= 1;
        return Promise.resolve({
          ok: false,
          providerCode: 'FAKE_FAILURE',
          error: '短信发送失败（测试）',
          ...failureResult,
        });
      }
      sent.push(message);
      counter += 1;
      return Promise.resolve({ ok: true, messageId: `fake-${counter}` });
    },
    lastCodeFor(phone) {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        const message = sent[i];
        if (message && message.phone === phone) {
          return message.params.find((param) => param.name === 'code')?.value;
        }
      }
      return undefined;
    },
    reset() {
      sent.length = 0;
      failures = 0;
      failureResult = {};
    },
    failNext(count = 1, result = {}) {
      failures = count;
      failureResult = result;
    },
  };
}
