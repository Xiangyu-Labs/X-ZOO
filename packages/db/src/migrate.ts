import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb } from './client';

/** Applies the committed migrations. Run by `pnpm db:migrate` and by the deploy scripts. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../migrations') });
    process.stdout.write('migrations applied\n');
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
