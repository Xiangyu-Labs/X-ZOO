import { sql } from 'drizzle-orm';
import { bigint, numeric, timestamp } from 'drizzle-orm/pg-core';

/**
 * Column helpers every schema file uses, so keys, money and time look the same in all tables.
 * Property names are camelCase; `casing: 'snake_case'` derives the column names.
 */

/** Identity primary key. BY DEFAULT (not ALWAYS) so seeds and imports can insert explicit ids. */
export const pk = () => bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity();

/** Foreign-key column; chain `.references(() => other.id, { onDelete })` and `.notNull()` at the use site. */
export const fk = () => bigint({ mode: 'number' });

/** numeric(12,2). Read and written as a string; convert with `Money` from core/kernel. */
export const money = () => numeric({ precision: 12, scale: 2 });

export const instant = () => timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => instant().notNull().defaultNow();

/** Maintained by the repo layer on write (`set({ updatedAt: clock.now() })`), not by a trigger. */
export const updatedAt = () => instant().notNull().defaultNow();

/** Soft delete marker. NULL means live. Prefer hard deletes unless history must survive. */
export const deletedAt = () => instant();

export const emptyJsonObject = sql`'{}'::jsonb`;
export const emptyJsonArray = sql`'[]'::jsonb`;
