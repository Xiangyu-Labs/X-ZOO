import { sql } from 'drizzle-orm';

import { createDb, type DbOrTx } from '../client';
import { notificationTemplates } from '../schema/notification';
import { agreements, cities, expressCompanies } from '../schema/reference';
import {
  agreementShells,
  loadCities,
  loadExpressCompanies,
  notificationTemplateShells,
} from './reference-data';

/**
 * Reference-data seed.
 *
 * Idempotent by construction: every statement is an upsert on a natural key,
 * so running it twice changes nothing and running it against a half-seeded
 * database completes it. It never touches business data, never creates an
 * admin account, and never seeds demo products, menus or configuration.
 */

/** PostgreSQL caps a statement at 65535 bind parameters; 500 rows stays well under it. */
const CHUNK = 500;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export interface SeedCounts {
  cities: number;
  expressCompanies: number;
  agreements: number;
  notificationTemplates: number;
}

/**
 * Seed (or re-seed) every reference table.
 *
 * Cities and courier companies carry explicit ids so addresses, freight
 * templates and shipments keep pointing at the same row across re-seeds; the
 * identity sequences are pushed past the seeded range afterwards so a later
 * manual insert cannot collide.
 */
export async function seedReference(db: DbOrTx): Promise<SeedCounts> {
  const cityRows = await loadCities();
  const expressRows = await loadExpressCompanies();

  // Parents before children: `cities.parent_id` is a real foreign key, and the
  // extractor already sorted the file by level.
  for (const batch of chunk(cityRows, CHUNK)) {
    await db
      .insert(cities)
      .values(batch)
      .onConflictDoUpdate({
        target: cities.id,
        set: {
          parentId: sql`excluded.parent_id`,
          level: sql`excluded.level`,
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          mergerName: sql`excluded.merger_name`,
          lng: sql`excluded.lng`,
          lat: sql`excluded.lat`,
          isVisible: sql`excluded.is_visible`,
        },
      });
  }

  for (const batch of chunk(expressRows, CHUNK)) {
    await db
      .insert(expressCompanies)
      .values(batch)
      .onConflictDoUpdate({
        target: expressCompanies.id,
        // The carrier's identity is ours (tracking keys on the code); its order
        // and 显示 switch are the operator's, set in the admin, and a re-seed on
        // every upgrade must not reset them.
        set: {
          code: sql`excluded.code`,
          name: sql`excluded.name`,
          updatedAt: sql`now()`,
        },
      });
  }

  // Shells: the code and the title are the contract; an existing body is never
  // overwritten, so re-running the seed cannot wipe an operator's text.
  await db
    .insert(agreements)
    .values(agreementShells)
    .onConflictDoUpdate({
      target: agreements.code,
      set: {
        title: sql`excluded.title`,
        sortOrder: sql`excluded.sort_order`,
        updatedAt: sql`now()`,
      },
    });

  await db
    .insert(notificationTemplates)
    .values(notificationTemplateShells)
    .onConflictDoUpdate({
      target: notificationTemplates.code,
      // The name and audience are the operator's, like an agreement's body. The
      // variables are the event's contract — what the code fills in — so a
      // release that changes them must reach existing rows.
      set: {
        variables: sql`excluded.variables`,
        updatedAt: sql`now()`,
      },
    });

  // Keep the identity sequences ahead of the explicitly seeded ids.
  await db.execute(
    sql`select setval(pg_get_serial_sequence('cities', 'id'), greatest((select max(id) from cities), 1))`,
  );
  await db.execute(
    sql`select setval(pg_get_serial_sequence('express_companies', 'id'), greatest((select max(id) from express_companies), 1))`,
  );

  return {
    cities: cityRows.length,
    expressCompanies: expressRows.length,
    agreements: agreementShells.length,
    notificationTemplates: notificationTemplateShells.length,
  };
}

/** `pnpm --filter @shop/db db:seed` */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exitCode = 1;
    return;
  }
  const handle = createDb(url);
  try {
    const counts = await handle.db.transaction((tx) => seedReference(tx));
    process.stdout.write(
      `seeded cities=${counts.cities} express_companies=${counts.expressCompanies} ` +
        `agreements=${counts.agreements} notification_templates=${counts.notificationTemplates}\n`,
    );
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
