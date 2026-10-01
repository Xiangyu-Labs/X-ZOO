import { describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { assertAllowed, jsapiSignature } from './wechat-oa.storefront.service';

/**
 * The JS-SDK signature and the host check in front of it.
 *
 * Signing whatever URL is handed in would turn the account's `jsapi_ticket`
 * into a signing oracle: any site could then call `wx.chooseWXPay` and
 * `wx.getLocation` with our brand on the permission sheet.
 */

describe('jsapiSignature', () => {
  it('reproduces WeChat’s own documented vector', () => {
    // From 微信 JS-SDK 说明文档, appendix 1. If this ever changes, the browser
    // says `invalid signature` and the server says nothing at all.
    expect(
      jsapiSignature({
        ticket:
          'sM4AOVdWfPE4DxkXGEs8VMCPGGVi4C3VM0P37wVUCFvkVAy_90u5h9nbSlYy3-Sl-HhTdfl2fzFy1AOcHKP7qg',
        nonceStr: 'Wm3WZYTPz0wzccnW',
        timestamp: '1414587457',
        url: 'http://mp.weixin.qq.com?params=value',
      }),
    ).toBe('0f9de62fce790f9a083d5c99e95740ceb90c27ed');
  });
});

/**
 * `assertAllowed` asks `isTrustedHost` in `@shop/core/system` (the deployment's
 * own hosts, from `site`) and then this domain's own JS-SDK 授权域名 list. The
 * fake config answers both readers from one object.
 */
function ctxWith(allowedHosts: string, publicOrigin = SITE): Ctx {
  return {
    config: {
      get: () =>
        Promise.resolve({ publicOrigin, extraOrigins: '', jsApiAllowedHosts: allowedHosts }),
    },
  } as unknown as Ctx;
}

const SITE = 'https://shop.example.com';

describe('assertAllowed', () => {
  it('always allows the site’s own host, configured or not', async () => {
    await expect(
      assertAllowed(ctxWith(''), 'https://shop.example.com/pages/index'),
    ).resolves.toBeUndefined();
  });

  it('allows a host an operator listed, in either spelling', async () => {
    await expect(
      assertAllowed(ctxWith('m.example.com, other.example.com'), 'https://m.example.com/p'),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowed(ctxWith('https://m.example.com'), 'https://m.example.com/p'),
    ).resolves.toBeUndefined();
  });

  it('compares the host, not a prefix', async () => {
    // `shop.example.com.attacker.test` starts with the allowed host and is a
    // completely different site.
    await expect(
      assertAllowed(ctxWith(''), 'https://shop.example.com.attacker.test/p'),
    ).rejects.toThrow(DomainError);
  });

  it('refuses a host nobody listed', async () => {
    await expect(
      assertAllowed(ctxWith('m.example.com'), 'https://attacker.test/p'),
    ).rejects.toThrow(/WECHAT_OA_URL_NOT_ALLOWED|不允许|地址/);
  });

  it('refuses a scheme that is not http(s), without asking anybody', async () => {
    await expect(assertAllowed(ctxWith(''), 'javascript:alert(1)')).rejects.toThrow(DomainError);
    await expect(assertAllowed(ctxWith(''), 'not a url')).rejects.toThrow(DomainError);
  });

  it('does not turn a misconfigured or missing origin into “allow everything”', async () => {
    await expect(
      assertAllowed(ctxWith('', 'not-a-url'), 'https://attacker.test/p'),
    ).rejects.toThrow(DomainError);
    await expect(assertAllowed(ctxWith('', ''), 'https://attacker.test/p')).rejects.toThrow(
      DomainError,
    );
  });

  it('ignores empty entries in the list', async () => {
    await expect(assertAllowed(ctxWith(' , , '), 'https://attacker.test/p')).rejects.toThrow(
      DomainError,
    );
  });
});
