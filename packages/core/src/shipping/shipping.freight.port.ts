import type { DbOrTx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { toId } from '../kernel/ids';
import { registerFreightPort, type FreightLine, type FreightQuote } from '../order/ports';
import { orderConfig } from '../order';
import {
  computeFreight,
  type FreightInputLine,
  type FreightTemplateRules,
} from './shipping.freight.rules';
import * as cityRepo from './shipping.repo';
import * as repo from './shipping.template.repo';

/**
 * The `FreightPort` checkout quotes through.
 *
 * Until this is registered, `fallbackFreightQuote` in `order.pricing.ts`
 * answers every quote and every 运费模板 line costs nothing. Registration is a
 * side effect of importing `@shop/core/shipping` (see `index.ts`), which
 * `@shop/core/domains` does for the app and the worker.
 *
 * Two seams worth naming:
 *
 *  - **the line's freight mode.** `FreightLine` carries `freightMode` and
 *    `fixedFreightFen`, so a free line and a fixed-postage line — both of which
 *    carry a `null` template id — are told apart from the argument, without
 *    re-reading skus checkout has just read.
 *  - **the address.** A region rule may name a province, a city or a district,
 *    so the address's division is expanded into its ancestor chain and the
 *    narrowest matching rule wins.
 *
 * 满额包邮 is settled here rather than in checkout, because only this side can
 * see that a fixed-postage line was part of the order it has to zero.
 */

export const freightPort = {
  async quote(
    db: DbOrTx,
    ctx: Ctx,
    input: { addressCityId: number | null; lines: readonly FreightLine[] },
  ): Promise<FreightQuote> {
    const empty = { totalFen: 0, perLine: input.lines.map(() => 0) };
    if (input.lines.length === 0) return empty;

    // Both reads go through `db`, one after the other: on checkout's `create`
    // it is a transaction — one connection, which a second pooled read on a
    // cold config cache must not wait behind, and which cannot run two queries
    // at once anyway.
    const cityPath = await cityPathOf(db, input.addressCityId);
    const config = await ctx.config.getIn(db, orderConfig);

    const lines: FreightInputLine[] = input.lines.map((line, index) => ({
      index,
      skuId: line.skuId,
      quantity: line.quantity,
      weight: line.weight,
      volume: line.volume,
      amountFen: line.amountFen,
      mode: line.freightMode,
      fixedFreightFen: line.fixedFreightFen,
      templateId: line.freightTemplateId,
    }));

    const templateIds = [
      ...new Set(
        lines
          .filter((line) => line.mode === 'template' && line.templateId !== null)
          .map((line) => line.templateId as number),
      ),
    ];
    const templates = await loadTemplates(db, templateIds);

    const result = computeFreight({
      lines,
      cityPath,
      templates,
      // The setting is in 元 ("0 表示不启用满额包邮"); everything else here is 分.
      freeThresholdFen: config.freeShippingThreshold * 100,
      goodsTotalFen: lines.reduce((sum, line) => sum + line.amountFen, 0),
    });

    if (result.undeliverable.length > 0) {
      throw new DomainError('SHIPPING_NOT_DELIVERABLE', {
        details: {
          skuIds: result.undeliverable.map((entry) => toId(entry.skuId)),
          templateIds: [...new Set(result.undeliverable.map((entry) => entry.templateId))].map(
            toId,
          ),
        },
      });
    }
    return { totalFen: result.totalFen, perLine: result.perLine };
  },
};

/** Idempotent; called from `index.ts` and safe to call again from a test. */
export function registerShippingFreightPort(): void {
  registerFreightPort(freightPort);
}

// ---------------------------------------------------------------------------
// the two lookups
// ---------------------------------------------------------------------------

/** The address's division and its ancestors, most specific first. */
async function cityPathOf(db: DbOrTx, addressCityId: number | null): Promise<number[]> {
  if (addressCityId === null) return [];
  return cityRepo.cityAncestry(db, addressCityId);
}

async function loadTemplates(
  db: DbOrTx,
  templateIds: number[],
): Promise<Map<number, FreightTemplateRules>> {
  const out = new Map<number, FreightTemplateRules>();
  if (templateIds.length === 0) return out;

  const [regions, freeRules, noDelivery] = await Promise.all([
    repo.listRegions(db, templateIds),
    repo.listFreeRules(db, templateIds),
    repo.listNoDeliveryCities(db, templateIds),
  ]);
  const heads = await Promise.all(templateIds.map((id) => repo.findTemplate(db, id)));

  for (const head of heads) {
    if (head === null) continue;
    out.set(head.id, {
      templateId: head.id,
      chargeMode: head.chargeMode,
      hasFreeRules: head.hasFreeRules,
      hasNoDeliveryRules: head.hasNoDeliveryRules,
      regions: (regions.get(head.id) ?? []).map((entry) => ({
        isFallback: entry.region.isFallback,
        cityIds: new Set(entry.cityIds),
        firstUnit: Number(entry.region.firstUnit),
        firstPriceFen: fen(entry.region.firstPrice),
        additionalUnit: Number(entry.region.additionalUnit),
        additionalPriceFen: fen(entry.region.additionalPrice),
      })),
      freeRules: (freeRules.get(head.id) ?? []).map((entry) => ({
        cityIds: new Set(entry.cityIds),
        minUnits: entry.rule.minUnits === null ? null : Number(entry.rule.minUnits),
        minAmountFen: entry.rule.minAmount === null ? null : fen(entry.rule.minAmount),
      })),
      noDeliveryCityIds: new Set(noDelivery.get(head.id) ?? []),
    });
  }
  return out;
}

/** `money` columns are `'12.34'` strings; the engine counts in 分. */
function fen(value: string): number {
  return Math.round(Number(value) * 100);
}
