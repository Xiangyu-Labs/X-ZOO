import { z } from 'zod';
import { registerConfigTest, testSteps } from '../kernel/config-test';
import { logisticsConfig } from '../system';
import { probeAliyunTracking } from './shipping.logistics.port';

const input = z.object({
  trackingNo: z.string().trim().min(4).max(40),
  companyCode: z.string().trim().max(20).default(''),
  phone: z
    .string()
    .trim()
    .regex(/^(\d{4}|\d{11})$/, '填手机号或后四位')
    .or(z.literal(''))
    .default(''),
});

/** The vendor's 200-with-an-error answers, in words an operator can act on. */
const NO_RESULT: Record<string, string> = {
  '0': '新单号可能还没揽收',
  '201': '快递单号不对',
  '204': '认不出快递公司，请填写快递公司编码',
  '205': '可能还没揽收，或快递公司填错了',
};

const STATE_NAME = {
  in_transit: '运输中',
  delivering: '派件中',
  delivered: '已签收',
  exception: '异常',
  unknown: '暂无状态',
} as const;

/**
 * 物流设置 → 「测试查询」.
 *
 * Looks up a tracking number the operator types, without the cache. The key is
 * working once the vendor answers, even when it knows nothing about that number
 * (a new parcel, a wrong carrier). So the result says whether the key works and
 * what was found, as separate things.
 */
export function registerShippingConfigTest(): void {
  registerConfigTest(logisticsConfig, {
    label: '测试查询',
    input,
    inputUi: {
      trackingNo: { label: '快递单号', type: 'text', placeholder: '一个真实的快递单号' },
      companyCode: {
        label: '快递公司编码',
        type: 'text',
        placeholder: '可不填，自动识别',
        help: '填「物流公司」列表里的编码（如 yuantong、shunfeng），或阿里云的编码（如 YTO、SFEXPRESS）',
      },
      phone: {
        label: '收件人手机号',
        type: 'text',
        placeholder: '可不填',
        help: '查顺丰必填，填后四位即可',
      },
    },
    async run(ctx, config, raw) {
      const t = testSteps(ctx);
      if (config.provider !== 'aliyun-market') {
        t.fail('检查配置', '「物流查询服务」为不启用，后台和小程序都不会显示物流轨迹');
        return t.result();
      }
      if (config.appCode.trim() === '') {
        t.fail('检查配置', '没有填写「AppCode」');
        return t.result();
      }
      const lookup = input.parse(raw);

      await t.step('查询物流轨迹', async () => {
        const probe = await probeAliyunTracking(ctx, config.appCode.trim(), lookup);
        if (!probe.reached) throw new Error(probe.reason);
        const { state, traces } = probe.result;
        if (traces.length === 0) {
          const why = NO_RESULT[probe.status];
          if (why === undefined) {
            ctx.logger.warn({ status: probe.status, msg: probe.message }, '物流测试查询没有结果');
            return '密钥可用，但这个单号没有查到轨迹';
          }
          return `密钥可用，但这个单号没有查到轨迹：${why}`;
        }
        const latest = traces[0]!;
        return `密钥可用；${STATE_NAME[state]}，共 ${traces.length} 条轨迹，最新：${latest.context}`;
      });
      return t.result();
    },
  });
}
