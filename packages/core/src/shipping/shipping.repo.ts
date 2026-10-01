import type { DbOrTx } from '@shop/db';
import { cities, expressCompanies } from '@shop/db/schema/reference';
import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { containsPattern } from '../kernel/like';

/**
 * The only file in the shipping domain that touches Drizzle tables
 * (`docs/conventions.md`, "Import boundaries").
 *
 * A repo function is a statement, not a decision: every `if` about a row count
 * lives in a service. The freight tables get their own repo
 * (`shipping.template.repo.ts`) because the template aggregate is written as
 * one delete-and-reinsert and reads best on its own.
 */

export type CityRow = typeof cities.$inferSelect;
export type ExpressCompanyRow = typeof expressCompanies.$inferSelect;

// ---------------------------------------------------------------------------
// cities — immutable seed data, reads only
// ---------------------------------------------------------------------------

export interface CityNode {
  id: number;
  parentId: number | null;
  level: number;
  name: string;
}

/**
 * The whole visible tree in one statement — about 3200 rows, cached in
 * process for the life of the container (`shipping.city.service.ts`). Paging a
 * tree the client has to assemble anyway would only make it slower.
 */
export async function listCities(db: DbOrTx): Promise<CityNode[]> {
  return db
    .select({
      id: cities.id,
      parentId: cities.parentId,
      level: cities.level,
      name: cities.name,
    })
    .from(cities)
    .where(eq(cities.isVisible, true))
    .orderBy(asc(cities.level), asc(cities.id));
}

/**
 * A cheap fingerprint of the tree: how many visible rows there are and the
 * largest id. Two aggregates over an index, run once per request, which is what
 * lets the built tree be cached in process without a cache-bust route ever
 * being needed.
 */
export async function cityFingerprint(db: DbOrTx): Promise<{ count: number; maxId: number }> {
  const rows = await db
    .select({ value: count(), maxId: sql<number | null>`max(${cities.id})` })
    .from(cities)
    .where(eq(cities.isVisible, true));
  const row = rows[0];
  return { count: row?.value ?? 0, maxId: Number(row?.maxId ?? 0) };
}

/**
 * A division and its ancestors, most specific first.
 *
 * A freight rule may name a province, a city or a district, and an address
 * carries exactly one division id, so pricing has to know the chain. The tree
 * is exactly three levels deep, so two left self-joins answer it in one round
 * trip — a recursive CTE would buy nothing but a plan nobody can read.
 */
export async function cityAncestry(db: DbOrTx, cityId: number): Promise<number[]> {
  const parent = alias(cities, 'parent_city');
  const grandParent = alias(cities, 'grand_parent_city');
  const rows = await db
    .select({ id: cities.id, parentId: parent.id, grandParentId: grandParent.id })
    .from(cities)
    .leftJoin(parent, eq(parent.id, cities.parentId))
    .leftJoin(grandParent, eq(grandParent.id, parent.parentId))
    .where(eq(cities.id, cityId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return [];
  return [row.id, row.parentId, row.grandParentId].filter(
    (value): value is number => value !== null,
  );
}

/** Which of these ids exist at all. Used to refuse a template that names a division we do not have. */
export async function existingCityIds(db: DbOrTx, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: cities.id })
    .from(cities)
    .where(sql`${cities.id} = any(${sql.param(ids)}::bigint[])`);
  return new Set(rows.map((row) => row.id));
}

/** Division names by id, for saying which rule an address hit. Unknown ids are absent. */
export async function cityNames(db: DbOrTx, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: cities.id, name: cities.name })
    .from(cities)
    .where(sql`${cities.id} = any(${sql.param(ids)}::bigint[])`);
  return new Map(rows.map((row) => [row.id, row.name]));
}

// ---------------------------------------------------------------------------
// express companies
// ---------------------------------------------------------------------------

/**
 * The picker body — enabled only, `sortOrder DESC, id ASC`, so the most used
 * carriers come first.
 */
export async function listEnabledExpressCompanies(db: DbOrTx): Promise<ExpressCompanyRow[]> {
  return db
    .select()
    .from(expressCompanies)
    .where(eq(expressCompanies.isEnabled, true))
    .orderBy(desc(expressCompanies.sortOrder), asc(expressCompanies.id));
}

/**
 * The shopper's picker (SHIP-003): enabled only, a WeChat courier code first (a return
 * shipped with one can be reported to 小程序发货信息管理), then `sortOrder DESC, id ASC`,
 * at most `limit`.
 */
export async function searchEnabledExpressCompanies(
  db: DbOrTx,
  args: { keyword?: string | undefined; limit: number },
): Promise<ExpressCompanyRow[]> {
  const filters: (SQL | undefined)[] = [eq(expressCompanies.isEnabled, true)];
  if (args.keyword) {
    const like = containsPattern(args.keyword);
    filters.push(or(ilike(expressCompanies.name, like), ilike(expressCompanies.code, like)));
  }
  return db
    .select()
    .from(expressCompanies)
    .where(and(...filters))
    .orderBy(
      sql`(${expressCompanies.wechatDeliveryId} is null)`,
      desc(expressCompanies.sortOrder),
      asc(expressCompanies.id),
    )
    .limit(args.limit);
}

export type ExpressSortKey = 'id' | 'sortOrder' | 'name';

const EXPRESS_SORT = {
  id: expressCompanies.id,
  sortOrder: expressCompanies.sortOrder,
  name: expressCompanies.name,
} as const;

export interface ExpressListArgs {
  keyword?: string | undefined;
  isEnabled?: boolean | undefined;
  sortBy?: ExpressSortKey | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  offset: number;
  limit: number;
}

export async function listExpressCompanies(
  db: DbOrTx,
  args: ExpressListArgs,
): Promise<{ rows: ExpressCompanyRow[]; total: number }> {
  const filters: SQL[] = [];
  if (args.keyword !== undefined && args.keyword !== '') {
    const like = containsPattern(args.keyword);
    const match = or(ilike(expressCompanies.name, like), ilike(expressCompanies.code, like));
    if (match) filters.push(match);
  }
  if (args.isEnabled !== undefined) filters.push(eq(expressCompanies.isEnabled, args.isEnabled));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const column = EXPRESS_SORT[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(expressCompanies)
      .where(where)
      .orderBy(direction(column), asc(expressCompanies.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ value: count() }).from(expressCompanies).where(where),
  ]);
  return { rows, total: totals[0]?.value ?? 0 };
}

export async function findExpressCompany(
  db: DbOrTx,
  id: number,
): Promise<ExpressCompanyRow | null> {
  const rows = await db.select().from(expressCompanies).where(eq(expressCompanies.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Enabled only — what a 发货 form is allowed to pick. */
export async function findEnabledExpressCompany(
  db: DbOrTx,
  id: number,
): Promise<ExpressCompanyRow | null> {
  const rows = await db
    .select()
    .from(expressCompanies)
    .where(and(eq(expressCompanies.id, id), eq(expressCompanies.isEnabled, true)))
    .limit(1);
  return rows[0] ?? null;
}

export interface ExpressCompanyValues {
  code: string;
  name: string;
  sortOrder: number;
  isEnabled: boolean;
  /** `undefined` leaves the column alone; `null` clears it. */
  wechatDeliveryId?: string | null | undefined;
}

export async function insertExpressCompany(
  db: DbOrTx,
  values: ExpressCompanyValues,
): Promise<ExpressCompanyRow> {
  const rows = await db.insert(expressCompanies).values(values).returning();
  const row = rows[0];
  if (row === undefined) throw new Error('insertExpressCompany: 未返回插入行');
  return row;
}

export async function updateExpressCompany(
  db: DbOrTx,
  id: number,
  values: Partial<ExpressCompanyValues>,
): Promise<ExpressCompanyRow | null> {
  const rows = await db
    .update(expressCompanies)
    .set({ ...values, updatedAt: sql`now()` })
    .where(eq(expressCompanies.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteExpressCompany(db: DbOrTx, id: number): Promise<number> {
  const rows = await db
    .delete(expressCompanies)
    .where(eq(expressCompanies.id, id))
    .returning({ id: expressCompanies.id });
  return rows.length;
}

/** PostgreSQL's foreign-key-violation SQLSTATE. */
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

function hasSqlState(error: unknown, state: string, constraint?: string): boolean {
  for (let current = error, depth = 0; current !== null && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === state) {
      return constraint === undefined || candidate.constraint === constraint;
    }
    if (typeof candidate.cause !== 'object' || candidate.cause === null) return false;
    current = candidate.cause;
  }
  return false;
}

/**
 * Whether PostgreSQL refused the delete because a shipment or a return still
 * points at the carrier.
 *
 * Asked as a caught error rather than as a pre-flight `count(*)`: the two
 * referencing tables (`shipments`, `refunds`) belong to other domains, and a
 * repo in `shipping` must not read them. The foreign keys are `restrict` and
 * `set null`, so the database is the authority anyway — and a pre-flight count
 * would race with a shipment created a millisecond later.
 */
export function isReferencedElsewhere(error: unknown): boolean {
  return hasSqlState(error, FOREIGN_KEY_VIOLATION);
}

export function isDuplicateCode(error: unknown): boolean {
  return hasSqlState(error, UNIQUE_VIOLATION, 'express_companies_code_uq');
}
