import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // One file per domain; files starting with `_` are helpers, not tables.
  schema: './src/schema/!(_)*.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://shop:shop@localhost:5432/shop' },
  casing: 'snake_case',
  strict: true,
});
