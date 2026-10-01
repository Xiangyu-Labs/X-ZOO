import { randomBytes } from 'node:crypto';
import { registerConfigTest, testSteps } from '../kernel/config-test';
import { safeFetch } from '../storage';
import { publicOrigin, wechatOaConfig } from '../system';
import { aesKeyOf, signatureOf } from './wechat-oa.crypto';
import { oaCredentials } from './wechat-oa.credentials';

const WEBHOOK_PATH = '/api/v1/webhooks/wechat-oa';
const TIMEOUT_MS = 5000;
const MODE_NAME = { plain: '明文模式', compatible: '兼容模式', safe: '安全模式' } as const;

/**
 * 微信公众号 → 「模拟服务器校验」.
 *
 * Does what 公众平台 does when the operator presses 提交 on 服务器配置: it
 * sends a signed GET to the callback URL on the shop's public address and
 * expects `echostr` back. So it checks the DNS, the HTTPS certificate, the
 * reverse proxy and the Token together, from outside, and prints the URL to
 * paste.
 *
 * The server answers with the **saved** Token. A Token typed but not saved
 * cannot be checked this way, and the step says so; it does not report a
 * mismatch.
 */
export function registerWechatOaConfigTest(): void {
  registerConfigTest(wechatOaConfig, {
    label: '模拟服务器校验',
    async run(ctx, config) {
      const t = testSteps(ctx);
      const saved = await oaCredentials(ctx);
      // The same fallback `oaCredentials` applies to the saved values.
      const token = config.token.trim() || saved.token;

      await t.step('检查配置', async () => {
        if (!/^[A-Za-z0-9]{3,32}$/.test(token)) {
          throw new Error('Token 须为 3–32 位英文字母或数字，与公众平台「服务器配置」里填的一致');
        }
        if (config.messageMode !== 'plain') {
          try {
            aesKeyOf(config.encodingAesKey.trim() || saved.encodingAesKey);
          } catch {
            throw new Error(`${MODE_NAME[config.messageMode]}需要 43 位的 EncodingAESKey`);
          }
        }
        const notes = [`${MODE_NAME[config.messageMode]}`];
        if (!config.enabled) notes.push('公众号尚未启用');
        if (saved.appId === '') notes.push('「微信公众号 / 小程序」里还没有填公众号 AppID');
        return notes.join('；');
      });

      await t.step('模拟公众平台校验服务器地址', async () => {
        const origin = await publicOrigin(ctx);
        if (origin === '') throw new Error('没有公网地址：部署时未设置 PUBLIC_ORIGIN');
        const url = `${origin}${WEBHOOK_PATH}`;
        if (token !== saved.token) {
          throw new Error(
            `Token 还没保存，服务器会用已保存的 Token 校验。保存后再测。服务器地址：${url}`,
          );
        }
        const timestamp = String(Math.floor(ctx.clock.now().getTime() / 1000));
        const nonce = randomBytes(8).toString('hex');
        const echostr = randomBytes(12).toString('hex');
        const query = new URLSearchParams({
          signature: signatureOf([token, timestamp, nonce]),
          timestamp,
          nonce,
          echostr,
        });
        const fetched = await safeFetch(`${url}?${query.toString()}`, {
          timeoutMs: TIMEOUT_MS,
          maxBytes: 1024,
        }).catch((error: unknown) => {
          // safeFetch's reasons are English (`DNS lookup failed`, `status 502`):
          // staff read what to check, and the reason goes to the log.
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn({ url, reason: message }, 'wechat oa callback check failed');
          throw new Error(
            /status 403/.test(message)
              ? `服务器拒绝了签名，检查服务器时钟。地址：${url}`
              : `公众平台将无法访问 ${url}，请检查域名解析、HTTPS 证书和反向代理是否指向本系统`,
          );
        });
        const body = Buffer.from(fetched.bytes).toString('utf8').trim();
        if (body !== echostr) {
          throw new Error(`${url} 能打开，但返回的不是校验串，检查反向代理是否指向本系统`);
        }
        return `校验通过。公众平台「设置与开发 → 基本配置 → 服务器配置」填写：URL ${url}，Token 与本页一致，消息加解密方式选「${MODE_NAME[config.messageMode]}」`;
      });
      return t.result();
    },
  });
}
