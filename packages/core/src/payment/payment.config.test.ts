import { describe, expect, it } from 'vitest';
import { wechatConfig } from '../wechat';
import { NOTIFY_PATHS, paymentConfig, paymentCredentials } from './payment.config';

/**
 * What the `payment` and `wechat` config groups may and may not contain.
 *
 * Config is where a shop's worst ideas end up, because a setting is the one
 * thing an operator can change without a deploy. Two of those ideas are tested
 * against here. (`refund`'s half of the same two rules lives in
 * `refund/refund.config.test.ts`: the boundary rule does not let a payment test
 * reach into the refund domain, and the rules are worth stating twice.)
 */

const GROUPS = [paymentConfig, wechatConfig] as const;

/**
 * TLS-001.
 *
 * A switch that turns certificate verification off, or a CA-bundle path an
 * operator can point anywhere, is what gets added when a server has a stale
 * trust store and disabling the check makes the error go away — after which
 * every payment on that shop is one DNS answer away from being read and
 * rewritten.
 *
 * So there is neither. Verification is the global `fetch`'s, the trust store is
 * the container's, and neither is reachable from an admin form. This test is
 * the guard that keeps it that way: a future field called `verifySsl` or
 * `caBundle` fails here before it reaches a review.
 */
const FORBIDDEN = /verif|ssl|tls|certificate_?authority|ca_?bundle|ca_?path|insecure|allow_?self/i;

describe('TLS-001 — no TLS toggle in any payment config group', () => {
  for (const group of GROUPS) {
    it(`has no verification switch in \`${group.group}\``, () => {
      const offenders = Object.keys(group.schema.shape).filter((key) => FORBIDDEN.test(key));
      expect(offenders).toEqual([]);
    });

    it(`exposes no such field in the \`${group.group}\` admin form`, () => {
      const offenders = Object.keys(group.ui ?? {}).filter((key) => FORBIDDEN.test(key));
      expect(offenders).toEqual([]);
    });
  }

  it('keeps the API host configurable but off the form, so it cannot be re-pointed by hand', () => {
    expect(Object.keys(paymentConfig.schema.shape)).toContain('apiBaseUrl');
    expect(Object.keys(paymentConfig.ui ?? {})).not.toContain('apiBaseUrl');
  });
});

/**
 * Every secret in these groups must be declared `secret: true`, because that
 * flag is the only thing standing between the merchant private key and an
 * admin-api response body. The list is spelled out rather than derived: a new
 * secret field should have to be added here deliberately.
 */
describe('secret fields are declared secret', () => {
  const SECRETS: Record<string, readonly string[]> = {
    payment: ['apiV3Key', 'merchantPrivateKey', 'platformPublicKey'],
    // The `wechat` group holds every WeChat credential, the mini program's
    // callback token and AES key included.
    wechat: ['oaAppSecret', 'oaToken', 'oaAesKey', 'miniAppSecret', 'miniToken', 'miniAesKey'],
  };

  for (const group of GROUPS) {
    const expected = SECRETS[group.group] ?? [];
    it(`marks every secret in \`${group.group}\``, () => {
      const ui = (group.ui ?? {}) as Record<string, { secret?: boolean } | undefined>;
      const declared = Object.keys(ui).filter((key) => ui[key]?.secret === true);
      expect(declared.sort()).toEqual([...expected].sort());
    });
  }
});

/**
 * An all-digit setting — a WeChat 商户号 is nothing else — must not come back
 * from the `jsonb` column as a *number*: `z.string()` would refuse it and
 * `ConfigService` would repair the field to its default, so the shop would
 * report 支付尚未配置 with a filled-in form and say nothing about why. The
 * schema is a plain `z.string()`; the round trip itself is asserted against a
 * real database in `payment.int.test.ts`, because that is where it can break.
 */
describe('the schema is plain strings', () => {
  it('takes a 商户号 as the string it is', () => {
    expect(paymentConfig.schema.parse({ mchId: '1900000001' }).mchId).toBe('1900000001');
  });

  it('still answers the default for a missing key', () => {
    const parsed = paymentConfig.schema.parse({});
    expect(parsed.mchId).toBe('');
    expect(parsed.apiBaseUrl).toBe('https://api.mch.weixin.qq.com');
    expect(parsed.payExpiryMinutes).toBe(30);
  });

  it('leaves an ordinary string alone', () => {
    const parsed = paymentConfig.schema.parse({ notifyBaseUrl: 'https://shop.example.com' });
    expect(parsed.notifyBaseUrl).toBe('https://shop.example.com');
  });
});

describe('paymentCredentials', () => {
  const base = paymentConfig.schema.parse({
    mchId: '1900000001',
    notifyBaseUrl: 'https://shop.example.com',
  });

  it('joins the two webhook paths onto the notify host', () => {
    const credentials = paymentCredentials(base);
    expect(credentials.transactionNotifyUrl).toBe(
      `https://shop.example.com${NOTIFY_PATHS.transaction}`,
    );
    expect(credentials.refundNotifyUrl).toBe(`https://shop.example.com${NOTIFY_PATHS.refund}`);
  });

  it('eats the trailing slash an operator will eventually type', () => {
    const credentials = paymentCredentials({
      ...base,
      notifyBaseUrl: 'https://shop.example.com///',
    });
    expect(credentials.transactionNotifyUrl).toBe(
      `https://shop.example.com${NOTIFY_PATHS.transaction}`,
    );
  });

  it('produces no URL at all when the host is not configured yet', () => {
    const credentials = paymentCredentials({ ...base, notifyBaseUrl: '' });
    expect(credentials.transactionNotifyUrl).toBe('');
    expect(credentials.refundNotifyUrl).toBe('');
  });
});
