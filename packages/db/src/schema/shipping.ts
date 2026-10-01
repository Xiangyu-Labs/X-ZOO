import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, money, pk, updatedAt } from './_shared';
import { cities } from './reference';

/**
 * Freight templates.
 *
 * A rule is a row and the cities it covers are a join table, so "which cities
 * does this rule cover" is a real query instead of a string scan. A rule with
 * **no** city rows is the template's fallback rule.
 */

/** What the freight is charged by. */
export const shippingTemplatesChargeMode = pgEnum('shipping_templates_charge_mode', [
  'quantity',
  'weight',
  'volume',
]);

export const shippingTemplates = pgTable(
  'shipping_templates',
  {
    id: pk(),
    name: varchar({ length: 100 }).notNull(),
    chargeMode: shippingTemplatesChargeMode().notNull().default('quantity'),
    /** Whether the free-shipping rules below apply at all. */
    hasFreeRules: boolean().notNull().default(false),
    /** Whether the no-delivery list below applies at all. */
    hasNoDeliveryRules: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index('shipping_templates_sort_idx').on(t.sortOrder)],
);

export type ShippingTemplate = typeof shippingTemplates.$inferSelect;
export type NewShippingTemplate = typeof shippingTemplates.$inferInsert;

/** One price rule: first `firstUnit` units cost `firstPrice`, each further `additionalUnit` costs `additionalPrice`. */
export const shippingTemplateRegions = pgTable(
  'shipping_template_regions',
  {
    id: pk(),
    templateId: fk()
      .notNull()
      .references(() => shippingTemplates.id, { onDelete: 'cascade' }),
    /** TRUE for the single fallback rule that applies where no city rule matches. */
    isFallback: boolean().notNull().default(false),
    firstUnit: numeric({ precision: 12, scale: 2 }).notNull(),
    firstPrice: money().notNull(),
    additionalUnit: numeric({ precision: 12, scale: 2 }).notNull().default('0'),
    additionalPrice: money().notNull().default('0.00'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('shipping_template_regions_template_idx').on(t.templateId),
    uniqueIndex('shipping_template_regions_fallback_uq')
      .on(t.templateId)
      .where(sql`is_fallback`),
    check(
      'shipping_template_regions_non_negative',
      sql`${t.firstUnit} >= 0 and ${t.firstPrice} >= 0 and ${t.additionalUnit} >= 0 and ${t.additionalPrice} >= 0`,
    ),
  ],
);

export type ShippingTemplateRegion = typeof shippingTemplateRegions.$inferSelect;
export type NewShippingTemplateRegion = typeof shippingTemplateRegions.$inferInsert;

export const shippingTemplateRegionCities = pgTable(
  'shipping_template_region_cities',
  {
    regionId: fk()
      .notNull()
      .references(() => shippingTemplateRegions.id, { onDelete: 'cascade' }),
    cityId: fk()
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.regionId, t.cityId] }),
    index('shipping_template_region_cities_city_idx').on(t.cityId),
  ],
);

export type ShippingTemplateRegionCity = typeof shippingTemplateRegionCities.$inferSelect;
export type NewShippingTemplateRegionCity = typeof shippingTemplateRegionCities.$inferInsert;

/** "Free over N units" / "free over ¥X" for a set of cities. */
export const shippingTemplateFreeRules = pgTable(
  'shipping_template_free_rules',
  {
    id: pk(),
    templateId: fk()
      .notNull()
      .references(() => shippingTemplates.id, { onDelete: 'cascade' }),
    /** Quantity / weight / volume threshold, in the template's charge unit. NULL = not used. */
    minUnits: numeric({ precision: 12, scale: 2 }),
    /** Order subtotal threshold. NULL = not used. */
    minAmount: money(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('shipping_template_free_rules_template_idx').on(t.templateId),
    check(
      'shipping_template_free_rules_non_negative',
      sql`(${t.minUnits} is null or ${t.minUnits} >= 0) and (${t.minAmount} is null or ${t.minAmount} >= 0)`,
    ),
    check(
      'shipping_template_free_rules_needs_threshold',
      sql`${t.minUnits} is not null or ${t.minAmount} is not null`,
    ),
  ],
);

export type ShippingTemplateFreeRule = typeof shippingTemplateFreeRules.$inferSelect;
export type NewShippingTemplateFreeRule = typeof shippingTemplateFreeRules.$inferInsert;

export const shippingTemplateFreeRuleCities = pgTable(
  'shipping_template_free_rule_cities',
  {
    freeRuleId: fk()
      .notNull()
      .references(() => shippingTemplateFreeRules.id, { onDelete: 'cascade' }),
    cityId: fk()
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.freeRuleId, t.cityId] }),
    index('shipping_template_free_rule_cities_city_idx').on(t.cityId),
  ],
);

export type ShippingTemplateFreeRuleCity = typeof shippingTemplateFreeRuleCities.$inferSelect;
export type NewShippingTemplateFreeRuleCity = typeof shippingTemplateFreeRuleCities.$inferInsert;

/** Cities the template refuses to ship to. Flat join table — there is nothing else to say about a row. */
export const shippingTemplateNoDeliveryCities = pgTable(
  'shipping_template_no_delivery_cities',
  {
    templateId: fk()
      .notNull()
      .references(() => shippingTemplates.id, { onDelete: 'cascade' }),
    cityId: fk()
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.cityId] }),
    index('shipping_template_no_delivery_cities_city_idx').on(t.cityId),
  ],
);

export type ShippingTemplateNoDeliveryCity = typeof shippingTemplateNoDeliveryCities.$inferSelect;
export type NewShippingTemplateNoDeliveryCity =
  typeof shippingTemplateNoDeliveryCities.$inferInsert;
