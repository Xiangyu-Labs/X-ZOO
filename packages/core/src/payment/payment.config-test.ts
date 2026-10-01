import { createPrivateKey, createPublicKey } from 'node:crypto';
import { registerConfigTest, testSteps } from '../kernel/config-test';
import { DomainError } from '../kernel/errors';
import { createWechatPayClient } from '../wechat';
import { paymentConfig, paymentCredentials } from './payment.config';

/** Why the gateway refused, for the codes a misconfigured merchant gets. */
const GATEWAY_HINTS: Record<string, string> = {
  SIGN_ERROR: '签名错误：「API 证书序列号」与「商户 API 私钥」不是同一张证书',
  INVALID_REQUEST: '请求被拒绝，多为证书序列号不属于这个商户号',
  MCH_NOT_EXISTS: '商户号不存在',
  NO_AUTH: '商户号没有这个接口的权限',
  PARAM_ERROR: '参数错误，多为商户号填写有误',
};

/** Why WeChat's answer could not be trusted. */
const VERIFY_HINTS: Record<string, string> = {
  'unknown-serial': '应答的公钥 ID 与「微信支付公钥 ID」不一致',
  'bad-signature': '应答签名验不过，「微信支付公钥」填错了或不是这个商户的',
  'missing-header': '应答没有签名，请求可能没到达微信支付',
  'stale-timestamp': '应答时间与本服务器时间相差超过 5 分钟，检查服务器时钟',
  transport: '连不上微信支付，检查服务器网络',
};

const REQUIRED = [
  ['mchId', '商户号'],
  ['apiV3Key', 'APIv3 密钥'],
  ['certSerial', 'API 证书序列号'],
  ['merchantPrivateKey', '商户 API 私钥'],
  ['platformPublicKeyId', '微信支付公钥 ID'],
  ['platformPublicKey', '微信支付公钥'],
  ['notifyBaseUrl', '回调域名'],
] as const;

/**
 * 微信支付 → 「测试签名」.
 *
 * Queries an order that does not exist. The request is signed with the
 * merchant key, and WeChat's reply is checked with the platform key. When the
 * gateway answers 「订单不存在」, the reply proves the 商户号, the certificate
 * serial, the private key and the platform key are right. No money moves and
 * no order is created.
 *
 * The APIv3 key is used only to decrypt callbacks, and this call cannot reach
 * it, so only its length is checked.
 */
export function registerPaymentConfigTest(): void {
  registerConfigTest(paymentConfig, {
    label: '测试签名',
    async run(ctx, config) {
      const t = testSteps(ctx);
      const missing = REQUIRED.filter(([key]) => config[key].trim() === '').map(([, l]) => l);
      if (missing.length > 0) {
        t.fail('检查配置', `没有填写：${missing.join('、')}`);
        return t.result();
      }
      if (config.apiV3Key.length !== 32) {
        t.fail('检查配置', `APIv3 密钥应为 32 位，现在是 ${config.apiV3Key.length} 位`);
        return t.result();
      }
      if (!/^https:\/\//.test(config.notifyBaseUrl)) {
        t.fail('检查配置', '回调域名必须以 https:// 开头，微信支付不回调 http 地址');
        return t.result();
      }

      await t.step('读取密钥', async () => {
        try {
          createPrivateKey(config.merchantPrivateKey);
        } catch {
          throw new Error('「商户 API 私钥」不是有效的 PEM 私钥（apiclient_key.pem 的全部内容）');
        }
        try {
          createPublicKey(config.platformPublicKey);
        } catch {
          throw new Error('「微信支付公钥」不是有效的 PEM 公钥');
        }
        return '私钥与公钥格式正确';
      });

      await t.step('签名请求并验签应答', async () => {
        const client = createWechatPayClient(ctx, paymentCredentials(config));
        const probe = `SHOPTEST${ctx.clock.now().getTime()}`;
        try {
          const found = await client.queryTransaction(probe);
          if (found !== null) return `查询到了订单 ${probe}，签名与验签均通过`;
        } catch (error) {
          throw new Error(explain(error), { cause: error });
        }
        return `微信支付接受了签名，应答用微信支付公钥验签通过（查询不存在的订单 ${probe}）`;
      });
      return t.result();
    },
  });
}

function explain(error: unknown): string {
  if (!(error instanceof DomainError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const details = (error.details ?? {}) as { code?: string; message?: string; reason?: string };
  if (error.code === 'PAYMENT_GATEWAY_REFUSED') {
    const code = details.code ?? 'UNKNOWN';
    return `${GATEWAY_HINTS[code] ?? '微信支付拒绝了请求'}。微信支付返回 ${code} ${details.message ?? ''}`.trim();
  }
  if (error.code === 'PAYMENT_STATE_UNKNOWN') {
    const reason = details.reason ?? '';
    return VERIFY_HINTS[reason] ?? `微信支付的应答无法确认（${reason}）`;
  }
  return error.message;
}
