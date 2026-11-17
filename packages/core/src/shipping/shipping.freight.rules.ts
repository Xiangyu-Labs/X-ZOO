/**
 * The freight algorithm, as pure functions.
 *
 * Two rules that an obvious implementation gets wrong:
 *
 *  - **no continuation rule means the first price, not zero.** When a group's
 *    quantity exceeds the template's first unit and the template has no
 *    continuation rule (`additionalUnit <= 0`), zero postage would make buying
 *    more make delivery free. That case charges `firstPrice`.
 *  - **fixed postage is per unit** (`postage × quantity`), not once per
 *    product.
 *
 * And one that looks like a bug and is not: when several templates are in one
 * order, the shop charges the *most expensive arrangement* — one template pays
 * its first-unit price and the others pay continuation only, tried once per
 * template that ties for the highest first price, and the maximum wins.
 * Operators price their catalogues around that behaviour.
 *
 * Money is integer 分 throughout. Measurements are floats, because a template
 * charges by kilogram or cubic metre with two decimals and `numeric(12,2)` is
 * what the column holds.
 */

export type ChargeMode = 'quantity' | 'weight' | 'volume';

/** One priced region of a template. `cityIds` empty ⇔ the fallback rule. */
export interface FreightRegion {
  isFallback: boolean;
  cityIds: ReadonlySet<number>;
  firstUnit: number;
  firstPriceFen: number;
  /** `0` means "no continuation rule". */
  additionalUnit: number;
  additionalPriceFen: number;
}

export interface FreightFreeRule {
  cityIds: ReadonlySet<number>;
  /** `null` = threshold unused, i.e. always satisfied. */
  minUnits: number | null;
  minAmountFen: number | null;
}

export interface FreightTemplateRules {
  templateId: number;
  chargeMode: ChargeMode;
  hasFreeRules: boolean;
  hasNoDeliveryRules: boolean;
  regions: readonly FreightRegion[];
  freeRules: readonly FreightFreeRule[];
  noDeliveryCityIds: ReadonlySet<number>;
}

/** What the engine needs about one cart line. Index is its position in the caller's array. */
export interface FreightInputLine {
  index: number;
  skuId: number;
  quantity: number;
  /** Grams. */
  weight: number;
  /** Cubic centimetres. */
  volume: number;
  amountFen: number;
  mode: 'free' | 'fixed' | 'template';
  /** 分 per unit, only read when `mode === 'fixed'`. */
  fixedFreightFen: number;
  templateId: number | null;
}

export interface FreightComputation {
  totalFen: number;
  /** Indexed like the caller's lines. Sums to `totalFen`. */
  perLine: number[];
  /** Lines the address cannot be delivered to, if any. Empty means "quote is valid". */
  undeliverable: { skuId: number; templateId: number }[];
}

const MICRO_PER_UNIT = 1_000_000n;

function thresholdToMicro(value: number): bigint {
  // Region & free-rule thresholds are `numeric(12,2)`, so `value * 100` is an exact safe integer.
  return BigInt(Math.round(value * 100)) * 10_000n;
}

function unitsToMicro(units: number): bigint {
  return BigInt(Math.round(units * 1_000_000));
}

function lineToMicro(line: FreightInputLine, mode: ChargeMode): bigint {
  switch (mode) {
    case 'quantity':
      return BigInt(Math.round(line.quantity)) * MICRO_PER_UNIT;
    case 'weight':
      return BigInt(Math.round(line.weight)) * 1_000n;
    case 'volume':
      return BigInt(Math.round(line.volume));
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n) return 0;
  return Number((numerator + denominator - 1n) / denominator);
}

/**
 * How much of the template's charging unit one line contributes.
 *
 * `weight` and `volume` arrive already multiplied by the quantity (checkout's
 * `freightLineOf` does that), in grams and cubic centimetres, while a template
 * is written in kilograms and cubic metres. One conversion, in one place.
 */
export function unitsOf(line: FreightInputLine, mode: ChargeMode): number {
  switch (mode) {
    case 'quantity':
      return line.quantity;
    case 'weight':
      return line.weight / 1000;
    case 'volume':
      return line.volume / 1_000_000;
  }
}

/**
 * The region that prices this address: the most specific city match, else the
 * fallback. An empty `cityPath` (a division we do not know) matches no city
 * rule and so gets the fallback too — never "no region", which would ship free.
 */
export function regionFor(
  regions: readonly FreightRegion[],
  cityPath: readonly number[],
): FreightRegion | null {
  // `cityPath` runs most-specific-first (district, city, province), so the
  // first hit is the narrowest rule an operator wrote — which is what an
  // operator means by writing both "浙江省 ¥8" and "杭州市 ¥5".
  for (const cityId of cityPath) {
    for (const region of regions) {
      if (region.cityIds.has(cityId)) return region;
    }
  }
  return regions.find((region) => region.isFallback) ?? null;
}

/** Whether a free-shipping rule of this template covers the address and both thresholds are met. */
export function isFreeByRule(
  template: FreightTemplateRules,
  cityPath: readonly number[],
  units: number,
  amountFen: number,
): boolean {
  return isFreeByRuleMicro(template, cityPath, unitsToMicro(units), amountFen);
}

function isFreeByRuleMicro(
  template: FreightTemplateRules,
  cityPath: readonly number[],
  microUnits: bigint,
  amountFen: number,
): boolean {
  if (!template.hasFreeRules) return false;
  for (const rule of template.freeRules) {
    const covered = cityPath.some((cityId) => rule.cityIds.has(cityId));
    if (!covered) continue;
    // A rule requires *both* thresholds (units and amount); a NULL threshold is
    // stored as "unused" and counts as met.
    if (rule.minUnits !== null && microUnits < thresholdToMicro(rule.minUnits)) continue;
    if (rule.minAmountFen !== null && amountFen < rule.minAmountFen) continue;
    return true;
  }
  return false;
}

/** Number of continuation lots charged above `firstUnit` (0 when within firstUnit or no rule). */
export function continuationCount(region: FreightRegion, units: number): number {
  return continuationCountMicro(region, unitsToMicro(units));
}

function continuationCountMicro(region: FreightRegion, microUnits: bigint): number {
  const firstMicro = thresholdToMicro(region.firstUnit);
  const addMicro = thresholdToMicro(region.additionalUnit);
  if (microUnits <= firstMicro || addMicro <= 0n) return 0;
  return ceilDiv(microUnits - firstMicro, addMicro);
}

/**
 * The group pays its first unit and every continuation after it.
 *
 * The `additionalUnit <= 0` branch charges the first price: zero here would
 * make a bigger cart ship free.
 */
export function firstAndContinuation(region: FreightRegion, units: number): number {
  return firstAndContinuationMicro(region, unitsToMicro(units));
}

function firstAndContinuationMicro(region: FreightRegion, microUnits: bigint): number {
  const extra = continuationCountMicro(region, microUnits);
  return region.firstPriceFen + extra * region.additionalPriceFen;
}

/** The group pays continuations only — what every template but one pays in an arrangement. */
export function continuationOnly(region: FreightRegion, units: number): number {
  return continuationOnlyMicro(region, unitsToMicro(units));
}

function continuationOnlyMicro(region: FreightRegion, microUnits: bigint): number {
  const addMicro = thresholdToMicro(region.additionalUnit);
  if (addMicro <= 0n) return 0;
  return ceilDiv(microUnits, addMicro) * region.additionalPriceFen;
}

interface GroupLine {
  index: number;
  microUnits: bigint;
}

interface Group {
  templateId: number;
  region: FreightRegion;
  microUnits: bigint;
  amountFen: number;
  lines: GroupLine[];
}

/**
 * Prices one cart against one address.
 *
 * `cityPath` is the address's division and its ancestors, most specific first.
 * An empty path is an address whose division is missing or unknown — one saved
 * without a `cityId`, or naming a division the city table does not have. It is
 * priced like an address in a province the template does not list: at the
 * fallback region, or free when the template has none. Pricing it as free
 * outright would make a missing city a way to skip postage. "No address yet"
 * never reaches here: checkout quotes zero without asking the port.
 */
export function computeFreight(input: {
  lines: readonly FreightInputLine[];
  cityPath: readonly number[];
  templates: ReadonlyMap<number, FreightTemplateRules>;
  /** Shop-wide 满额包邮. `0` disables it. Compared against the goods total. */
  freeThresholdFen: number;
  goodsTotalFen: number;
}): FreightComputation {
  const perLine = new Array<number>(input.lines.length).fill(0);
  const undeliverable: { skuId: number; templateId: number }[] = [];

  // 1. fixed postage, charged per unit.
  for (const line of input.lines) {
    if (line.mode === 'fixed') perLine[line.index] = line.fixedFreightFen * line.quantity;
  }

  // 2. group the template lines, and refuse an address a template excludes.
  const groups = new Map<number, Group>();
  for (const line of input.lines) {
    if (line.mode !== 'template' || line.templateId === null) continue;
    const template = input.templates.get(line.templateId);
    // A line pointing at a template that no longer exists ships free rather
    // than crashing a checkout; the product editor is where that is fixed.
    if (template === undefined) continue;
    if (
      template.hasNoDeliveryRules &&
      input.cityPath.some((cityId) => template.noDeliveryCityIds.has(cityId))
    ) {
      undeliverable.push({ skuId: line.skuId, templateId: template.templateId });
      continue;
    }
    const region = regionFor(template.regions, input.cityPath);
    if (region === null) continue;
    const existing = groups.get(line.templateId);
    const microUnits = lineToMicro(line, template.chargeMode);
    if (existing === undefined) {
      groups.set(line.templateId, {
        templateId: line.templateId,
        region,
        microUnits,
        amountFen: line.amountFen,
        lines: [{ index: line.index, microUnits }],
      });
    } else {
      existing.microUnits += microUnits;
      existing.amountFen += line.amountFen;
      existing.lines.push({ index: line.index, microUnits });
    }
  }
  if (undeliverable.length > 0) {
    return { totalFen: 0, perLine, undeliverable };
  }

  // 3. a group whose free rule matches drops out of the calculation entirely.
  const charged: Group[] = [];
  for (const group of groups.values()) {
    const template = input.templates.get(group.templateId);
    if (template === undefined) continue;
    if (isFreeByRuleMicro(template, input.cityPath, group.microUnits, group.amountFen)) continue;
    charged.push(group);
  }

  // 4. the arrangement that costs the most wins.
  if (charged.length > 0) {
    const maxFirst = Math.max(...charged.map((group) => group.region.firstPriceFen));
    let best: { total: number; leader: Group } | null = null;
    for (const leader of charged) {
      if (leader.region.firstPriceFen !== maxFirst) continue;
      let total = firstAndContinuationMicro(leader.region, leader.microUnits);
      for (const other of charged) {
        if (other === leader) continue;
        total += continuationOnlyMicro(other.region, other.microUnits);
      }
      if (best === null || total > best.total) best = { total, leader };
    }
    if (best !== null) {
      for (const group of charged) {
        const amount =
          group === best.leader
            ? firstAndContinuationMicro(group.region, group.microUnits)
            : continuationOnlyMicro(group.region, group.microUnits);
        attribute(group, amount, perLine);
      }
    }
  }

  // 5. shop-wide 满额包邮 zeroes everything, fixed lines included.
  if (input.freeThresholdFen > 0 && input.goodsTotalFen >= input.freeThresholdFen) {
    return { totalFen: 0, perLine: perLine.map(() => 0), undeliverable };
  }

  return { totalFen: perLine.reduce((sum, value) => sum + value, 0), perLine, undeliverable };
}

/**
 * Splits a group's postage over its lines by share of the group's units, the
 * last line taking the remainder so the parts always sum back exactly. Same
 * rule as `Money.allocate`, done in 分 because the port speaks integers.
 */
function attribute(group: Group, amountFen: number, perLine: number[]): void {
  if (group.lines.length === 0 || amountFen === 0) return;
  const total = group.microUnits;
  let assigned = 0;
  group.lines.forEach((line, position) => {
    if (position === group.lines.length - 1) {
      perLine[line.index] = (perLine[line.index] ?? 0) + (amountFen - assigned);
      return;
    }
    const share =
      total <= 0n
        ? Math.floor(amountFen / group.lines.length)
        : Number((BigInt(amountFen) * line.microUnits) / total);
    perLine[line.index] = (perLine[line.index] ?? 0) + share;
    assigned += share;
  });
}
