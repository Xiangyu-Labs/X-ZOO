import type { ShippingTemplateForm } from '@shop/contracts/shipping/schemas';
import { describe, expect, it } from 'vitest';
import { explainTrial } from './shipping.freight.trial';

// 北京市 › 北京市 › 朝阳区, most specific first, as `cityAncestry` returns it.
const CHAOYANG = [110105, 110100, 110000];
const HANGZHOU = [330100, 330000];
const MACAU = [820100, 820000];
const NAMES = new Map([
  [110000, '北京市'],
  [110100, '北京市'],
  [110105, '朝阳区'],
  [330000, '浙江省'],
  [330100, '杭州市'],
  [820000, '澳门特别行政区'],
  [820100, '澳门半岛'],
]);

const TEMPLATE: ShippingTemplateForm = {
  name: '测试模板',
  chargeMode: 'quantity',
  sortOrder: 0,
  hasFreeRules: true,
  hasNoDeliveryRules: true,
  regions: [
    {
      isFallback: true,
      cityIds: [],
      firstUnit: 1,
      firstPrice: '10.00',
      additionalUnit: 1,
      additionalPrice: '5.00',
    },
    {
      isFallback: false,
      cityIds: ['110100'],
      firstUnit: 2,
      firstPrice: '6.00',
      additionalUnit: 1,
      additionalPrice: '2.00',
    },
  ],
  freeRules: [{ cityIds: ['110000'], minUnits: 5, minAmount: '199.00' }],
  noDeliveryCityIds: ['820000'],
};

const run = (
  overrides: Partial<Parameters<typeof explainTrial>[0]> = {},
): ReturnType<typeof explainTrial> =>
  explainTrial({
    template: TEMPLATE,
    cityPath: CHAOYANG,
    names: NAMES,
    units: 3,
    amountFen: 12_000,
    freeThresholdFen: 0,
    ...overrides,
  });

describe('explainTrial', () => {
  it('names the region rule the address hit and shows the arithmetic', () => {
    const result = run();
    expect(result.outcome).toBe('charged');
    expect(result.fee).toBe('8.00');
    expect(result.steps).toEqual([
      '收货地区：北京市 › 北京市 › 朝阳区',
      '命中第 2 条地区规则（北京市）',
      '第 1 条包邮规则覆盖该地区，但未满足：还差 2 件，金额还差 ¥79.00',
      '首 2 件 ¥6.00 + 续 1 次（每 1 件 ¥2.00）= ¥8.00',
    ]);
  });

  it('falls back to 默认全国 when no region rule covers the address', () => {
    const result = run({ cityPath: HANGZHOU, units: 1 });
    expect(result.fee).toBe('10.00');
    expect(result.steps).toContain('没有命中任何地区规则，按「默认全国」计算');
    expect(result.steps).toContain('没有包邮规则覆盖该地区');
    expect(result.steps.at(-1)).toBe('1 件 在首 1 件 以内，运费 ¥10.00');
  });

  it('says which free rule made it free', () => {
    const result = run({ units: 5, amountFen: 19_900 });
    expect(result).toMatchObject({ outcome: 'free-by-rule', fee: '0.00' });
    expect(result.steps.at(-1)).toBe('满足第 1 条包邮规则，包邮');
  });

  it('refuses an address on the no-delivery list', () => {
    const result = run({ cityPath: MACAU });
    expect(result).toMatchObject({ outcome: 'undeliverable', fee: '0.00' });
    expect(result.steps.at(-1)).toBe('「澳门特别行政区」在「不配送地区」里，下单会被拒绝');
  });

  it('applies the shop-wide threshold after the template', () => {
    const result = run({ freeThresholdFen: 10_000 });
    expect(result).toMatchObject({ outcome: 'free-by-threshold', fee: '0.00' });
    expect(result.steps.at(-1)).toContain('达到全店满额包邮 ¥100.00');
  });

  it('charges the first price when there is no continuation rule', () => {
    const template: ShippingTemplateForm = {
      ...TEMPLATE,
      chargeMode: 'weight',
      hasFreeRules: false,
      regions: [{ ...TEMPLATE.regions[0]!, firstUnit: 1, additionalUnit: 0 }],
    };
    const result = run({ template, cityPath: HANGZHOU, units: 2.5 });
    expect(result.fee).toBe('10.00');
    expect(result.steps.at(-1)).toBe('首 1 kg ¥10.00；续费单位为 0，超出部分不再加收，运费 ¥10.00');
  });

  it('prices weight in the engine’s grams exactly like checkout', () => {
    const template: ShippingTemplateForm = {
      ...TEMPLATE,
      chargeMode: 'weight',
      hasFreeRules: false,
      regions: [{ ...TEMPLATE.regions[0]!, firstUnit: 1, additionalUnit: 0.5 }],
    };
    // 2.3 kg: first 1 kg ¥10, then ceil(1.3 / 0.5) = 3 continuations × ¥5.
    const result = run({ template, cityPath: HANGZHOU, units: 2.3 });
    expect(result.fee).toBe('25.00');
  });
});
