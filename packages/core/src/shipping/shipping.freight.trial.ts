import type {
  ShippingTemplateForm,
  ShippingTemplateTrialBody,
  ShippingTemplateTrialResult,
} from '@shop/contracts/shipping/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId } from '../kernel/ids';
import { Money } from '../kernel/money';
import { orderConfig } from '../order';
import {
  computeFreight,
  firstAndContinuation,
  regionFor,
  unitsOf,
  type ChargeMode,
  type FreightInputLine,
  type FreightTemplateRules,
} from './shipping.freight.rules';
import * as cityRepo from './shipping.repo';

/**
 * 运费试算: one product, one address, the template as the drawer holds it.
 *
 * The fee comes from `computeFreight` — the function checkout quotes through —
 * so the trial cannot disagree with what a shopper is charged. The steps are
 * the same decisions retold in the operator's words: which rule the address
 * hit, whether a free rule covered it and what it was short of, and the
 * arithmetic.
 */
export async function trial(
  ctx: Ctx,
  body: ShippingTemplateTrialBody,
): Promise<ShippingTemplateTrialResult> {
  const cityId = fromId(body.cityId);
  const cityPath = await cityRepo.cityAncestry(ctx.db, cityId);
  if (cityPath.length === 0) {
    throw new DomainError('SHIPPING_CITY_UNKNOWN', { details: { cityIds: [body.cityId] } });
  }
  const mentioned = [
    ...cityPath,
    ...body.template.regions.flatMap((region) => region.cityIds.map(fromId)),
    ...body.template.freeRules.flatMap((rule) => rule.cityIds.map(fromId)),
  ];
  const [names, config] = await Promise.all([
    cityRepo.cityNames(ctx.db, [...new Set(mentioned)]),
    ctx.config.get(orderConfig),
  ]);
  return explainTrial({
    template: body.template,
    cityPath,
    names,
    units: body.units,
    amountFen: Money.parse(body.amount).valueOfFen(),
    freeThresholdFen: config.freeShippingThreshold * 100,
  });
}

const UNIT: Record<ChargeMode, string> = { quantity: '件', weight: 'kg', volume: 'm³' };

export interface TrialInput {
  template: ShippingTemplateForm;
  /** Most specific first, as `cityAncestry` returns it. */
  cityPath: readonly number[];
  names: ReadonlyMap<number, string>;
  units: number;
  amountFen: number;
  freeThresholdFen: number;
}

/** The pure half of the trial: the fee and the words for it. */
export function explainTrial(input: TrialInput): ShippingTemplateTrialResult {
  const { template, cityPath, names } = input;
  const unit = UNIT[template.chargeMode];
  const rules = toRules(template);
  const nameOf = (cityId: number): string => names.get(cityId) ?? `#${cityId}`;
  const yuan = (fen: number): string => `¥${Money.fromFen(fen).toString()}`;
  const steps = [`收货地区：${[...cityPath].reverse().map(nameOf).join(' › ')}`];

  if (rules.hasNoDeliveryRules) {
    const blocked = cityPath.find((cityId) => rules.noDeliveryCityIds.has(cityId));
    if (blocked !== undefined) {
      steps.push(`「${nameOf(blocked)}」在「不配送地区」里，下单会被拒绝`);
      return { outcome: 'undeliverable', fee: '0.00', steps };
    }
  }

  const region = regionFor(rules.regions, cityPath);
  if (region === null) {
    // The form's schema requires a fallback, so this is a template nobody can save.
    steps.push('没有「默认全国」规则，也没有命中任何地区规则，运费为 0');
    return { outcome: 'charged', fee: '0.00', steps };
  }
  const regionIndex = rules.regions.indexOf(region);
  if (region.isFallback) {
    steps.push('没有命中任何地区规则，按「默认全国」计算');
  } else {
    const hit = cityPath.find((cityId) => region.cityIds.has(cityId));
    steps.push(`命中第 ${regionIndex + 1} 条地区规则（${hit === undefined ? '' : nameOf(hit)}）`);
  }

  if (rules.hasFreeRules) {
    const free = explainFreeRules(template, cityPath, input.units, input.amountFen, unit, yuan);
    steps.push(...free.steps);
    if (free.matched) return { outcome: 'free-by-rule', fee: '0.00', steps };
  }

  const fee = firstAndContinuation(region, input.units);
  steps.push(arithmetic(region, input.units, unit, fee, yuan));

  const line = trialLine(template.chargeMode, input.units, input.amountFen);
  const computed = computeFreight({
    lines: [line],
    cityPath,
    templates: new Map([[0, rules]]),
    freeThresholdFen: input.freeThresholdFen,
    goodsTotalFen: input.amountFen,
  });
  if (input.freeThresholdFen > 0 && input.amountFen >= input.freeThresholdFen) {
    steps.push(
      `商品金额 ${yuan(input.amountFen)} 达到全店满额包邮 ${yuan(input.freeThresholdFen)}（订单设置），运费为 0`,
    );
    return { outcome: 'free-by-threshold', fee: '0.00', steps };
  }
  return { outcome: 'charged', fee: Money.fromFen(computed.totalFen).toString(), steps };
}

function explainFreeRules(
  template: ShippingTemplateForm,
  cityPath: readonly number[],
  units: number,
  amountFen: number,
  unit: string,
  yuan: (fen: number) => string,
): { matched: boolean; steps: string[] } {
  const steps: string[] = [];
  for (const [index, rule] of template.freeRules.entries()) {
    const covered = rule.cityIds.map(fromId).some((cityId) => cityPath.includes(cityId));
    if (!covered) continue;
    const short: string[] = [];
    if (rule.minUnits !== null && units < rule.minUnits) {
      short.push(`还差 ${round2(rule.minUnits - units)} ${unit}`);
    }
    const minFen = rule.minAmount === null ? null : Money.parse(rule.minAmount).valueOfFen();
    if (minFen !== null && amountFen < minFen) short.push(`金额还差 ${yuan(minFen - amountFen)}`);
    if (short.length === 0) {
      steps.push(`满足第 ${index + 1} 条包邮规则，包邮`);
      return { matched: true, steps };
    }
    steps.push(`第 ${index + 1} 条包邮规则覆盖该地区，但未满足：${short.join('，')}`);
  }
  if (steps.length === 0) steps.push('没有包邮规则覆盖该地区');
  return { matched: false, steps };
}

function arithmetic(
  region: {
    firstUnit: number;
    firstPriceFen: number;
    additionalUnit: number;
    additionalPriceFen: number;
  },
  units: number,
  unit: string,
  fee: number,
  yuan: (fen: number) => string,
): string {
  const first = `首 ${region.firstUnit} ${unit} ${yuan(region.firstPriceFen)}`;
  if (units <= region.firstUnit) {
    return `${units} ${unit} 在首 ${region.firstUnit} ${unit} 以内，运费 ${yuan(fee)}`;
  }
  if (region.additionalUnit <= 0) {
    return `${first}；续费单位为 0，超出部分不再加收，运费 ${yuan(fee)}`;
  }
  const times = Math.ceil((units - region.firstUnit) / region.additionalUnit);
  return `${first} + 续 ${times} 次（每 ${region.additionalUnit} ${unit} ${yuan(region.additionalPriceFen)}）= ${yuan(fee)}`;
}

/** One cart line carrying `units` of the template's own unit, in the engine's grams and cm³. */
function trialLine(mode: ChargeMode, units: number, amountFen: number): FreightInputLine {
  const line: FreightInputLine = {
    index: 0,
    skuId: 0,
    quantity: mode === 'quantity' ? units : 1,
    weight: mode === 'weight' ? units * 1000 : 0,
    volume: mode === 'volume' ? units * 1_000_000 : 0,
    amountFen,
    mode: 'template',
    fixedFreightFen: 0,
    templateId: 0,
  };
  // The engine's unit conversion is the one checkout uses; the round trip must be exact.
  if (round2(unitsOf(line, mode)) !== units) {
    throw new Error('freight trial unit conversion drifted');
  }
  return line;
}

function toRules(template: ShippingTemplateForm): FreightTemplateRules {
  const fen = (value: string): number => Money.parse(value).valueOfFen();
  return {
    templateId: 0,
    chargeMode: template.chargeMode,
    hasFreeRules: template.hasFreeRules,
    hasNoDeliveryRules: template.hasNoDeliveryRules,
    regions: template.regions.map((region) => ({
      isFallback: region.isFallback,
      cityIds: new Set(region.cityIds.map(fromId)),
      firstUnit: region.firstUnit,
      firstPriceFen: fen(region.firstPrice),
      additionalUnit: region.additionalUnit,
      additionalPriceFen: fen(region.additionalPrice),
    })),
    freeRules: template.freeRules.map((rule) => ({
      cityIds: new Set(rule.cityIds.map(fromId)),
      minUnits: rule.minUnits,
      minAmountFen: rule.minAmount === null ? null : fen(rule.minAmount),
    })),
    noDeliveryCityIds: new Set(template.noDeliveryCityIds.map(fromId)),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
