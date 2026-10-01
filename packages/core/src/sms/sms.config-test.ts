import { phoneNumber } from '@shop/contracts/auth/storefront-schemas';
import { z } from 'zod';
import { registerConfigTest, testSteps } from '../kernel/config-test';
import { smsConfig } from '../system';
import { getSmsSenderOverride } from './sms.port';
import { senderFor, smsProviderConfigured } from './sms.service';
import { generateCode } from './verification-code';

const PROVIDER_NAME = { aliyun: '阿里云', tencent: '腾讯云', none: '不启用' } as const;

/**
 * 短信设置 → 「发送测试短信」.
 *
 * Sends the verification-code template, with a random code, to the phone the
 * operator typed. That is the one template every shop must have working (it is
 * the login), and a real send is the only check that covers the sign name and
 * the template approval as well as the keys. It is billed, so the screen asks
 * first.
 */
export function registerSmsConfigTest(): void {
  registerConfigTest(smsConfig, {
    label: '发送测试短信',
    confirm: '会向这个号码真实发送一条验证码短信，由短信服务商计费。确定发送吗？',
    input: z.object({ phone: phoneNumber }),
    inputUi: {
      phone: { label: '接收手机号', type: 'text', placeholder: '11 位手机号' },
    },
    async run(ctx, config, input) {
      const t = testSteps(ctx);
      const override = getSmsSenderOverride();
      if (!override && !smsProviderConfigured(config)) {
        t.fail(
          '检查配置',
          config.provider === 'none' ? '未选择短信服务商' : '服务商的密钥或签名还没填完整',
        );
        return t.result();
      }
      if (config.templateVerifyCode === '') {
        t.fail('检查配置', '没有填写「验证码模板 ID」');
        return t.result();
      }
      const sign = config.provider === 'aliyun' ? config.aliyunSignName : config.tencentSignName;
      await t.step('检查配置', async () =>
        override
          ? `使用注入的发送器 ${override.name}（测试环境）`
          : `${PROVIDER_NAME[config.provider]} · 签名「${sign}」· 模板 ${config.templateVerifyCode}`,
      );
      await t.step('发送验证码短信', async () => {
        const sender = override ?? senderFor(ctx, config);
        const result = await sender.send({
          phone: String(input.phone),
          templateId: config.templateVerifyCode,
          params: [{ name: 'code', value: generateCode() }],
        });
        if (!result.ok) {
          throw new Error(
            [result.providerCode, result.error].filter((part) => part).join(' · ') || '服务商拒绝',
          );
        }
        return result.messageId ? `已受理，消息 ID ${result.messageId}` : '已受理';
      });
      return t.result();
    },
  });
}
