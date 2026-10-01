import { z } from 'zod';
import { defineConfigGroup, type ConfigVisibleWhen } from '../kernel/config-registry';

/** Each vendor's credentials are shown only while that vendor is selected. */
const ALIYUN: ConfigVisibleWhen = { key: 'provider', equals: 'aliyun' };
const TENCENT: ConfigVisibleWhen = { key: 'provider', equals: 'tencent' };

/**
 * `sms` — the SMS provider.
 *
 * 一号通 is out of scope, so the provider list is the two direct ones, Aliyun
 * and Tencent Cloud, plus `none`, which is the default and makes the shop work
 * without any SMS account at all.
 *
 * The user domain reads this group when sending a verification code.
 */
export const smsConfig = defineConfigGroup({
  group: 'sms',
  title: '短信设置',
  description: '短信服务商密钥、签名、模板与发送频率。',
  category: 'integration',
  permission: 'system:config:read',
  schema: z.object({
    provider: z.enum(['none', 'aliyun', 'tencent']).default('none'),

    aliyunAccessKeyId: z.string().max(128).default(''),
    aliyunAccessKeySecret: z.string().max(128).default(''),
    aliyunRegionId: z.string().max(32).default('cn-hangzhou'),
    aliyunSignName: z.string().max(64).default(''),

    tencentAppId: z.string().max(64).default(''),
    tencentSecretId: z.string().max(128).default(''),
    tencentSecretKey: z.string().max(128).default(''),
    tencentSignName: z.string().max(64).default(''),
    tencentRegion: z.string().max(32).default('ap-guangzhou'),

    /** Template ids, keyed by the event that sends them. */
    templateVerifyCode: z.string().max(64).default(''),
    templateOrderPaid: z.string().max(64).default(''),
    templateOrderShipped: z.string().max(64).default(''),

    /** Per-phone budget, enforced by `rate-limit.ts` at the send site. */
    perPhonePerHour: z.number().int().min(1).max(50).default(5),
    perPhonePerDay: z.number().int().min(1).max(200).default(20),
  }),
  status: (c) => {
    if (c.provider === 'none') return { tone: 'off', text: '未启用' };
    const name = c.provider === 'aliyun' ? '阿里云' : '腾讯云';
    const keys =
      c.provider === 'aliyun'
        ? [c.aliyunAccessKeyId, c.aliyunAccessKeySecret, c.aliyunSignName]
        : [c.tencentAppId, c.tencentSecretId, c.tencentSecretKey, c.tencentSignName];
    if (keys.some((value) => value === ''))
      return { tone: 'incomplete', text: `${name} · 密钥或签名未填` };
    if (c.templateVerifyCode === '') return { tone: 'incomplete', text: `${name} · 缺验证码模板` };
    return { tone: 'on', text: name };
  },
  ui: {
    provider: {
      label: '短信服务商',
      type: 'select',
      options: [
        { label: '不启用', value: 'none' },
        { label: '阿里云', value: 'aliyun' },
        { label: '腾讯云', value: 'tencent' },
      ],
      order: 1,
    },
    aliyunAccessKeyId: {
      label: 'AccessKeyId',
      type: 'text',
      section: '阿里云',
      visibleWhen: ALIYUN,
      order: 10,
    },
    aliyunAccessKeySecret: {
      label: 'AccessKeySecret',
      type: 'password',
      secret: true,
      section: '阿里云',
      visibleWhen: ALIYUN,
      order: 11,
    },
    aliyunRegionId: {
      label: 'RegionId',
      type: 'text',
      section: '阿里云',
      visibleWhen: ALIYUN,
      order: 12,
    },
    aliyunSignName: {
      label: '短信签名',
      type: 'text',
      section: '阿里云',
      visibleWhen: ALIYUN,
      order: 13,
    },

    tencentAppId: {
      label: 'SdkAppId',
      type: 'text',
      section: '腾讯云',
      visibleWhen: TENCENT,
      order: 20,
      help: '腾讯云控制台「短信 → 应用管理 → 应用列表」中的 SDKAppID（1400 开头）',
    },
    tencentSecretId: {
      label: 'SecretId',
      type: 'text',
      section: '腾讯云',
      visibleWhen: TENCENT,
      order: 21,
      help: '建议用只授权 QcloudSMSFullAccess 的 CAM 子用户密钥',
    },
    tencentSecretKey: {
      label: 'SecretKey',
      type: 'password',
      secret: true,
      section: '腾讯云',
      visibleWhen: TENCENT,
      order: 22,
    },
    tencentSignName: {
      label: '短信签名',
      type: 'text',
      section: '腾讯云',
      visibleWhen: TENCENT,
      order: 23,
      help: '审核通过的签名内容，不带【】',
    },
    tencentRegion: {
      label: '地域',
      type: 'text',
      section: '腾讯云',
      visibleWhen: TENCENT,
      order: 24,
      help: '留空即 ap-guangzhou',
    },

    templateVerifyCode: {
      label: '验证码模板 ID',
      type: 'text',
      section: '模板',
      order: 30,
      help: '模板只含验证码一个变量：阿里云写 ${code}，腾讯云写 {1}',
    },
    templateOrderPaid: { label: '支付成功模板 ID', type: 'text', section: '模板', order: 31 },
    templateOrderShipped: { label: '发货提醒模板 ID', type: 'text', section: '模板', order: 32 },

    perPhonePerHour: { label: '每号码每小时上限', type: 'number', section: '频率', order: 40 },
    perPhonePerDay: { label: '每号码每天上限', type: 'number', section: '频率', order: 41 },
  },
});
