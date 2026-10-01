import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, fk, pk, updatedAt } from './_shared';
import { productSkus, products } from './catalog';
import { users } from './user';

/**
 * The shopping cart.
 *
 * One row per (user, SKU); adding the same SKU again increments the quantity
 * through a single `INSERT … ON CONFLICT DO UPDATE`, so two concurrent adds can
 * never produce two rows.
 *
 * There is no "buy now" pseudo-cart row: a direct purchase, a group-buy join
 * and a presale order are built from a request payload and never touch this
 * table.
 */
export const cartItems = pgTable(
  'cart_items',
  {
    id: pk(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    skuId: fk()
      .notNull()
      .references(() => productSkus.id, { onDelete: 'cascade' }),
    quantity: integer().notNull(),
    /** Whether the row is ticked in the cart UI. Kept server-side so it survives a device switch. */
    isSelected: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cart_items_user_sku_uq').on(t.userId, t.skuId),
    index('cart_items_user_idx').on(t.userId, t.updatedAt),
    index('cart_items_product_idx').on(t.productId),
    check('cart_items_quantity_positive', sql`${t.quantity} >= 1`),
  ],
);

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;
