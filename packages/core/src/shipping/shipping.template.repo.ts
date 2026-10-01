import type { DbOrTx, Tx } from '@shop/db';
import { products } from '@shop/db/schema/catalog';
import { groupbuyActivities } from '@shop/db/schema/groupbuy';
import { presaleActivities } from '@shop/db/schema/presale';
import {
  shippingTemplateFreeRuleCities,
  shippingTemplateFreeRules,
  shippingTemplateNoDeliveryCities,
  shippingTemplateRegionCities,
  shippingTemplateRegions,
  shippingTemplates,
} from '@shop/db/schema/shipping';
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { containsPattern } from '../kernel/like';

/**
 * The 运费模板 aggregate's statements.
 *
 * A template is five tables that only ever change together, so the write path
 * is "delete the children, insert the new ones", inside the caller's
 * transaction. That is simpler than diffing rule rows and it is what the form
 * means: the operator submits the template as a whole.
 *
 * One deliberate cross-domain read: `countProductsPerTemplate` counts rows in
 * `products` (the catalog's table). It is read-only, it is one `group by` over
 * an index that exists for it (`products_shipping_template_idx`), and the
 * alternative — a port on the catalogue just to answer "how many" — would be a
 * seam nobody else needs.
 */

export type TemplateRow = typeof shippingTemplates.$inferSelect;
export type RegionRow = typeof shippingTemplateRegions.$inferSelect;
export type FreeRuleRow = typeof shippingTemplateFreeRules.$inferSelect;

const live = (): SQL | undefined => isNull(shippingTemplates.deletedAt);

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export type TemplateSortKey = 'id' | 'sortOrder' | 'createdAt';

const TEMPLATE_SORT = {
  id: shippingTemplates.id,
  sortOrder: shippingTemplates.sortOrder,
  createdAt: shippingTemplates.createdAt,
} as const;

export interface TemplateListArgs {
  keyword?: string | undefined;
  chargeMode?: 'quantity' | 'weight' | 'volume' | undefined;
  sortBy?: TemplateSortKey | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  offset: number;
  limit: number;
}

export async function listTemplates(
  db: DbOrTx,
  args: TemplateListArgs,
): Promise<{ rows: TemplateRow[]; total: number }> {
  const filters: SQL[] = [];
  const liveOnly = live();
  if (liveOnly) filters.push(liveOnly);
  if (args.keyword !== undefined && args.keyword !== '') {
    filters.push(ilike(shippingTemplates.name, containsPattern(args.keyword)));
  }
  if (args.chargeMode !== undefined) {
    filters.push(eq(shippingTemplates.chargeMode, args.chargeMode));
  }
  const where = and(...filters);

  const column = TEMPLATE_SORT[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(shippingTemplates)
      .where(where)
      .orderBy(direction(column), desc(shippingTemplates.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ value: count() }).from(shippingTemplates).where(where),
  ]);
  return { rows, total: totals[0]?.value ?? 0 };
}

export async function listAllTemplates(db: DbOrTx): Promise<TemplateRow[]> {
  return db
    .select()
    .from(shippingTemplates)
    .where(live())
    .orderBy(desc(shippingTemplates.sortOrder), desc(shippingTemplates.id));
}

export async function findTemplate(db: DbOrTx, id: number): Promise<TemplateRow | null> {
  const rows = await db
    .select()
    .from(shippingTemplates)
    .where(and(eq(shippingTemplates.id, id), live()))
    .limit(1);
  return rows[0] ?? null;
}

/** How many live products point at each of these templates. Empty ids ⇒ empty map. */
export async function countProductsPerTemplate(
  db: DbOrTx,
  templateIds: number[],
): Promise<Map<number, number>> {
  if (templateIds.length === 0) return new Map();
  const rows = await db
    .select({ templateId: products.shippingTemplateId, value: count() })
    .from(products)
    .where(and(inArray(products.shippingTemplateId, templateIds), isNull(products.deletedAt)))
    .groupBy(products.shippingTemplateId);
  const out = new Map<number, number>();
  for (const row of rows) {
    if (row.templateId !== null) out.set(row.templateId, row.value);
  }
  return out;
}

/**
 * How many live activities (预售, 拼团) charge by each of these templates. The
 * same deliberate cross-domain read as the product count, for the same reason:
 * a template soft-deleted under a running campaign would quote nothing. An
 * ended campaign charges nobody, so it does not hold the template.
 */
export async function countActivitiesPerTemplate(
  db: DbOrTx,
  templateIds: number[],
): Promise<Map<number, number>> {
  if (templateIds.length === 0) return new Map();
  const out = new Map<number, number>();
  for (const table of [presaleActivities, groupbuyActivities] as const) {
    const rows = await db
      .select({ templateId: table.shippingTemplateId, value: count() })
      .from(table)
      .where(
        and(
          inArray(table.shippingTemplateId, templateIds),
          isNull(table.deletedAt),
          ne(table.status, 'ended'),
        ),
      )
      .groupBy(table.shippingTemplateId);
    for (const row of rows) {
      if (row.templateId !== null)
        out.set(row.templateId, (out.get(row.templateId) ?? 0) + row.value);
    }
  }
  return out;
}

export interface RegionWithCities {
  region: RegionRow;
  cityIds: number[];
}

export async function listRegions(
  db: DbOrTx,
  templateIds: number[],
): Promise<Map<number, RegionWithCities[]>> {
  const out = new Map<number, RegionWithCities[]>();
  if (templateIds.length === 0) return out;
  const regions = await db
    .select()
    .from(shippingTemplateRegions)
    .where(inArray(shippingTemplateRegions.templateId, templateIds))
    // Fallback first, the way the form shows it: 「默认全国」 is the row an
    // operator reads before the exceptions.
    .orderBy(desc(shippingTemplateRegions.isFallback), asc(shippingTemplateRegions.id));
  if (regions.length === 0) return out;

  const cityRows = await db
    .select()
    .from(shippingTemplateRegionCities)
    .where(
      inArray(
        shippingTemplateRegionCities.regionId,
        regions.map((region) => region.id),
      ),
    );
  const citiesByRegion = new Map<number, number[]>();
  for (const row of cityRows) {
    const bucket = citiesByRegion.get(row.regionId);
    if (bucket === undefined) citiesByRegion.set(row.regionId, [row.cityId]);
    else bucket.push(row.cityId);
  }
  for (const region of regions) {
    const entry = { region, cityIds: citiesByRegion.get(region.id) ?? [] };
    const bucket = out.get(region.templateId);
    if (bucket === undefined) out.set(region.templateId, [entry]);
    else bucket.push(entry);
  }
  return out;
}

export interface FreeRuleWithCities {
  rule: FreeRuleRow;
  cityIds: number[];
}

export async function listFreeRules(
  db: DbOrTx,
  templateIds: number[],
): Promise<Map<number, FreeRuleWithCities[]>> {
  const out = new Map<number, FreeRuleWithCities[]>();
  if (templateIds.length === 0) return out;
  const rules = await db
    .select()
    .from(shippingTemplateFreeRules)
    .where(inArray(shippingTemplateFreeRules.templateId, templateIds))
    .orderBy(asc(shippingTemplateFreeRules.id));
  if (rules.length === 0) return out;

  const cityRows = await db
    .select()
    .from(shippingTemplateFreeRuleCities)
    .where(
      inArray(
        shippingTemplateFreeRuleCities.freeRuleId,
        rules.map((rule) => rule.id),
      ),
    );
  const citiesByRule = new Map<number, number[]>();
  for (const row of cityRows) {
    const bucket = citiesByRule.get(row.freeRuleId);
    if (bucket === undefined) citiesByRule.set(row.freeRuleId, [row.cityId]);
    else bucket.push(row.cityId);
  }
  for (const rule of rules) {
    const entry = { rule, cityIds: citiesByRule.get(rule.id) ?? [] };
    const bucket = out.get(rule.templateId);
    if (bucket === undefined) out.set(rule.templateId, [entry]);
    else bucket.push(entry);
  }
  return out;
}

export async function listNoDeliveryCities(
  db: DbOrTx,
  templateIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (templateIds.length === 0) return out;
  const rows = await db
    .select()
    .from(shippingTemplateNoDeliveryCities)
    .where(inArray(shippingTemplateNoDeliveryCities.templateId, templateIds));
  for (const row of rows) {
    const bucket = out.get(row.templateId);
    if (bucket === undefined) out.set(row.templateId, [row.cityId]);
    else bucket.push(row.cityId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

export interface TemplateValues {
  name: string;
  chargeMode: 'quantity' | 'weight' | 'volume';
  hasFreeRules: boolean;
  hasNoDeliveryRules: boolean;
  sortOrder: number;
}

export interface RegionValues {
  isFallback: boolean;
  cityIds: number[];
  firstUnit: string;
  firstPrice: string;
  additionalUnit: string;
  additionalPrice: string;
}

export interface FreeRuleValues {
  cityIds: number[];
  minUnits: string | null;
  minAmount: string | null;
}

export async function insertTemplate(tx: Tx, values: TemplateValues): Promise<TemplateRow> {
  const rows = await tx.insert(shippingTemplates).values(values).returning();
  const row = rows[0];
  if (row === undefined) throw new Error('insertTemplate: 未返回插入行');
  return row;
}

export async function updateTemplate(tx: Tx, id: number, values: TemplateValues): Promise<number> {
  const rows = await tx
    .update(shippingTemplates)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(shippingTemplates.id, id), live()))
    .returning({ id: shippingTemplates.id });
  return rows.length;
}

/**
 * Replaces every child row of a template.
 *
 * `regions` and `free_rules` cascade to their city tables, so three deletes
 * clear the lot. Called inside the caller's transaction, always paired with the
 * inserts below.
 */
export async function replaceChildren(
  tx: Tx,
  templateId: number,
  input: { regions: RegionValues[]; freeRules: FreeRuleValues[]; noDeliveryCityIds: number[] },
): Promise<void> {
  await tx
    .delete(shippingTemplateRegions)
    .where(eq(shippingTemplateRegions.templateId, templateId));
  await tx
    .delete(shippingTemplateFreeRules)
    .where(eq(shippingTemplateFreeRules.templateId, templateId));
  await tx
    .delete(shippingTemplateNoDeliveryCities)
    .where(eq(shippingTemplateNoDeliveryCities.templateId, templateId));

  for (const region of input.regions) {
    const inserted = await tx
      .insert(shippingTemplateRegions)
      .values({
        templateId,
        isFallback: region.isFallback,
        firstUnit: region.firstUnit,
        firstPrice: region.firstPrice,
        additionalUnit: region.additionalUnit,
        additionalPrice: region.additionalPrice,
      })
      .returning({ id: shippingTemplateRegions.id });
    const regionId = inserted[0]?.id;
    if (regionId === undefined) throw new Error('replaceChildren: 区域规则未返回主键');
    if (region.cityIds.length > 0) {
      await tx
        .insert(shippingTemplateRegionCities)
        .values(region.cityIds.map((cityId) => ({ regionId, cityId })));
    }
  }

  for (const rule of input.freeRules) {
    const inserted = await tx
      .insert(shippingTemplateFreeRules)
      .values({ templateId, minUnits: rule.minUnits, minAmount: rule.minAmount })
      .returning({ id: shippingTemplateFreeRules.id });
    const freeRuleId = inserted[0]?.id;
    if (freeRuleId === undefined) throw new Error('replaceChildren: 包邮规则未返回主键');
    if (rule.cityIds.length > 0) {
      await tx
        .insert(shippingTemplateFreeRuleCities)
        .values(rule.cityIds.map((cityId) => ({ freeRuleId, cityId })));
    }
  }

  if (input.noDeliveryCityIds.length > 0) {
    await tx
      .insert(shippingTemplateNoDeliveryCities)
      .values(input.noDeliveryCityIds.map((cityId) => ({ templateId, cityId })));
  }
}

/** Soft delete. Refused by the service while a product still points at the template. */
export async function softDeleteTemplate(tx: Tx, id: number): Promise<number> {
  const rows = await tx
    .update(shippingTemplates)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(shippingTemplates.id, id), live()))
    .returning({ id: shippingTemplates.id });
  return rows.length;
}
