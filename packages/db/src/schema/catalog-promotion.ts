import { sql } from 'drizzle-orm';
import { check, integer, pgTable } from 'drizzle-orm/pg-core';
import { fk, updatedAt } from './_shared';
import { products } from './catalog';
import { presaleActivities } from './presale';
import { groupbuyActivities } from './groupbuy';

/** One current campaign per product; terminal campaigns remain linked for the editor. */
export const productPromotions = pgTable(
  'product_promotions',
  {
    productId: fk()
      .primaryKey()
      .references(() => products.id, { onDelete: 'restrict' }),
    presaleActivityId: fk().references(() => presaleActivities.id, { onDelete: 'restrict' }),
    groupbuyActivityId: fk().references(() => groupbuyActivities.id, { onDelete: 'restrict' }),
    version: integer().notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'product_promotions_exclusive',
      sql`${t.presaleActivityId} is null or ${t.groupbuyActivityId} is null`,
    ),
    check('product_promotions_version_positive', sql`${t.version} > 0`),
  ],
);
