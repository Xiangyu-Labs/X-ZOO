import { configValues } from '@shop/db/schema/system';
import type { DbOrTx } from '@shop/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * The only file that touches `config_values`. `docs/conventions.md`: "Only
 * `*.repo.ts` files touch Drizzle tables" — the ESLint boundary rule enforces
 * it, and the kernel holds itself to the same rule the domains do.
 */

export interface ConfigRow {
  key: string;
  value: unknown;
}

export async function loadGroup(db: DbOrTx, group: string): Promise<ConfigRow[]> {
  return db
    .select({ key: configValues.key, value: configValues.value })
    .from(configValues)
    .where(eq(configValues.group, group));
}

export async function upsertValues(
  tx: DbOrTx,
  group: string,
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  options: { updatedBy?: number | null; now: Date },
): Promise<void> {
  if (entries.length === 0) return;
  await tx
    .insert(configValues)
    .values(
      entries.map((e) => ({
        group,
        key: e.key,
        value: e.value as never,
        updatedAt: options.now,
        updatedBy: options.updatedBy ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [configValues.group, configValues.key],
      set: {
        value: sql`excluded.value`,
        updatedAt: options.now,
        updatedBy: options.updatedBy ?? null,
      },
    });
}

export async function deleteValues(
  tx: DbOrTx,
  group: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await tx
    .delete(configValues)
    .where(and(eq(configValues.group, group), inArray(configValues.key, [...keys])));
}
