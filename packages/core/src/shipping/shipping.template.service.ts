import type { PageQuery } from '@shop/contracts/conventions';
import type {
  ShippingTemplateDetail,
  ShippingTemplateForm,
  ShippingTemplateListItem,
  ShippingTemplateListQuery,
  ShippingTemplateOptions,
} from '@shop/contracts/shipping/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import * as cityRepo from './shipping.repo';
import * as repo from './shipping.template.repo';

/**
 * 运费模板.
 *
 * A template is an aggregate of five tables that only ever change together, so
 * a write is one transaction: update the head, delete every child row, insert
 * the submitted ones. The form has already been validated by its zod schema
 * (exactly one fallback region, no cities on it, a threshold on every free
 * rule), so what is left here is the two things a schema cannot know: the
 * cities exist, and the template is not in use when somebody deletes it.
 */

export async function list(
  ctx: Ctx,
  query: ShippingTemplateListQuery,
): Promise<{ items: ShippingTemplateListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listTemplates(ctx.db, {
    keyword: query.keyword,
    chargeMode: query.chargeMode,
    sortBy: query.sortBy as repo.TemplateSortKey | undefined,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  const counts = await repo.countProductsPerTemplate(
    ctx.db,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) => toListItem(row, counts.get(row.id) ?? 0)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** The product editor's select. Name and charge mode, nothing else. */
export async function options(ctx: Ctx): Promise<ShippingTemplateOptions> {
  const rows = await repo.listAllTemplates(ctx.db);
  return {
    items: rows.map((row) => ({ id: toId(row.id), name: row.name, chargeMode: row.chargeMode })),
  };
}

export async function detail(ctx: Ctx, params: { id: string }): Promise<ShippingTemplateDetail> {
  const id = fromId(params.id);
  const row = await repo.findTemplate(ctx.db, id);
  if (row === null) throw new DomainError('SHIPPING_TEMPLATE_NOT_FOUND');

  const [regions, freeRules, noDelivery, counts] = await Promise.all([
    repo.listRegions(ctx.db, [id]),
    repo.listFreeRules(ctx.db, [id]),
    repo.listNoDeliveryCities(ctx.db, [id]),
    repo.countProductsPerTemplate(ctx.db, [id]),
  ]);

  return {
    ...toListItem(row, counts.get(id) ?? 0),
    regions: (regions.get(id) ?? []).map((entry) => ({
      isFallback: entry.region.isFallback,
      cityIds: entry.cityIds.map(toId),
      firstUnit: Number(entry.region.firstUnit),
      firstPrice: entry.region.firstPrice,
      additionalUnit: Number(entry.region.additionalUnit),
      additionalPrice: entry.region.additionalPrice,
    })),
    freeRules: (freeRules.get(id) ?? []).map((entry) => ({
      cityIds: entry.cityIds.map(toId),
      minUnits: entry.rule.minUnits === null ? null : Number(entry.rule.minUnits),
      minAmount: entry.rule.minAmount,
    })),
    noDeliveryCityIds: (noDelivery.get(id) ?? []).map(toId),
  };
}

export async function create(
  ctx: Ctx,
  body: ShippingTemplateForm,
): Promise<ShippingTemplateDetail> {
  const children = await parseChildren(ctx, body);
  const id = await ctx.withTx(async (tx) => {
    const row = await repo.insertTemplate(tx, head(body));
    await repo.replaceChildren(tx, row.id, children);
    return row.id;
  });
  return detail(ctx, { id: toId(id) });
}

export async function update(
  ctx: Ctx,
  params: { id: string },
  body: ShippingTemplateForm,
): Promise<ShippingTemplateDetail> {
  const id = fromId(params.id);
  const children = await parseChildren(ctx, body);
  await ctx.withTx(async (tx) => {
    const affected = await repo.updateTemplate(tx, id, head(body));
    if (affected === 0) throw new DomainError('SHIPPING_TEMPLATE_NOT_FOUND');
    await repo.replaceChildren(tx, id, children);
  });
  return detail(ctx, params);
}

/**
 * Soft delete, refused while a product or a running activity still points at
 * the template.
 *
 * The foreign key from `products.shipping_template_id` is `restrict`, but this
 * is a *soft* delete: without the check the row would survive the delete and
 * the product would quietly start quoting zero freight. Asked as a count, in
 * the same transaction, so two operators cannot slip past each other.
 */
export async function remove(ctx: Ctx, params: { id: string }): Promise<{ deleted: true }> {
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    const productCount = (await repo.countProductsPerTemplate(tx, [id])).get(id) ?? 0;
    const activityCount = (await repo.countActivitiesPerTemplate(tx, [id])).get(id) ?? 0;
    if (productCount > 0 || activityCount > 0) {
      throw new DomainError('SHIPPING_TEMPLATE_IN_USE', {
        details: { productCount, activityCount },
      });
    }
    const affected = await repo.softDeleteTemplate(tx, id);
    if (affected === 0) throw new DomainError('SHIPPING_TEMPLATE_NOT_FOUND');
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// form -> rows
// ---------------------------------------------------------------------------

function head(body: ShippingTemplateForm): repo.TemplateValues {
  return {
    name: body.name,
    chargeMode: body.chargeMode,
    hasFreeRules: body.hasFreeRules,
    hasNoDeliveryRules: body.hasNoDeliveryRules,
    sortOrder: body.sortOrder,
  };
}

/**
 * Turns the form into child rows, and refuses ids the city table does not have.
 *
 * Every city the form mentions is checked in one query rather than per rule:
 * the region picker sends whole provinces, so a template can name several
 * hundred divisions and a per-rule check would be a per-rule round trip.
 */
async function parseChildren(
  ctx: Ctx,
  body: ShippingTemplateForm,
): Promise<{
  regions: repo.RegionValues[];
  freeRules: repo.FreeRuleValues[];
  noDeliveryCityIds: number[];
}> {
  const regions = body.regions.map((region) => ({
    isFallback: region.isFallback,
    cityIds: region.cityIds.map(fromId),
    firstUnit: region.firstUnit.toFixed(2),
    firstPrice: region.firstPrice,
    additionalUnit: region.additionalUnit.toFixed(2),
    additionalPrice: region.additionalPrice,
  }));
  const freeRules = body.freeRules.map((rule) => ({
    cityIds: rule.cityIds.map(fromId),
    minUnits: rule.minUnits === null ? null : rule.minUnits.toFixed(2),
    minAmount: rule.minAmount,
  }));
  const noDeliveryCityIds = body.noDeliveryCityIds.map(fromId);

  const mentioned = [
    ...regions.flatMap((region) => region.cityIds),
    ...freeRules.flatMap((rule) => rule.cityIds),
    ...noDeliveryCityIds,
  ];
  const unique = [...new Set(mentioned)];
  const known = await cityRepo.existingCityIds(ctx.db, unique);
  const missing = unique.filter((cityId) => !known.has(cityId));
  if (missing.length > 0) {
    throw new DomainError('SHIPPING_CITY_UNKNOWN', {
      details: { cityIds: missing.map(toId) },
    });
  }
  return { regions, freeRules, noDeliveryCityIds };
}

function toListItem(row: repo.TemplateRow, productCount: number): ShippingTemplateListItem {
  return {
    id: toId(row.id),
    name: row.name,
    chargeMode: row.chargeMode,
    hasFreeRules: row.hasFreeRules,
    hasNoDeliveryRules: row.hasNoDeliveryRules,
    sortOrder: row.sortOrder,
    productCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function pageBounds(query: PageQuery): { offset: number; limit: number } {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}
