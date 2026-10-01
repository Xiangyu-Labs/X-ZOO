import type { DbOrTx, Tx } from '@shop/db';
import {
  decorDocuments,
  decorRevisions,
  type DecorDocument,
  type DecorRevision,
} from '@shop/db/schema/decor';
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { containsPattern } from '../kernel/like';

/** The only file that touches `decor_documents` and `decor_revisions`. */

export type DocumentRow = DecorDocument;
export type RevisionRow = DecorRevision;
export type DocumentKindValue = DecorDocument['kind'];
export type DesignationValue = NonNullable<DecorDocument['designation']>;

/** A document with its live revision's summary columns, as every admin read needs. */
export interface DocumentWithLive {
  document: DocumentRow;
  live: Omit<RevisionRow, 'content'> | null;
}

const live = isNull(decorDocuments.deletedAt);

const revisionSummaryColumns = {
  id: decorRevisions.id,
  documentId: decorRevisions.documentId,
  number: decorRevisions.number,
  authorAdminId: decorRevisions.authorAdminId,
  note: decorRevisions.note,
  restoredFrom: decorRevisions.restoredFrom,
  createdAt: decorRevisions.createdAt,
};

async function withLive(
  db: DbOrTx,
  where: SQL | undefined,
  page?: { limit: number; offset: number },
) {
  const query = db
    .select({ document: decorDocuments, live: revisionSummaryColumns })
    .from(decorDocuments)
    .leftJoin(decorRevisions, eq(decorRevisions.id, decorDocuments.publishedRevisionId))
    .where(where)
    // `id` breaks ties so paging is stable when two rows share a timestamp.
    .orderBy(desc(decorDocuments.updatedAt), desc(decorDocuments.id));
  const rows = page ? await query.limit(page.limit).offset(page.offset) : await query;
  return rows.map((row) => ({
    document: row.document,
    live: row.live?.id == null ? null : row.live,
  }));
}

export async function listDocuments(
  db: DbOrTx,
  options: {
    kind?: DocumentKindValue | undefined;
    keyword?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ items: DocumentWithLive[]; total: number }> {
  const parts: (SQL | undefined)[] = [live];
  if (options.kind) parts.push(eq(decorDocuments.kind, options.kind));
  if (options.keyword) {
    const pattern = containsPattern(options.keyword);
    parts.push(or(ilike(decorDocuments.name, pattern), ilike(decorDocuments.title, pattern)));
  }
  const where = and(...parts);
  const items = await withLive(db, where, { limit: options.limit, offset: options.offset });
  const [totals] = await db.select({ value: count() }).from(decorDocuments).where(where);
  return { items, total: totals?.value ?? 0 };
}

export async function findDocument(db: DbOrTx, id: number): Promise<DocumentWithLive | null> {
  const [row] = await withLive(db, and(eq(decorDocuments.id, id), live));
  return row ?? null;
}

/** The live documents holding `designation`, at most one (the partial unique index). */
export async function findDesignated(
  db: DbOrTx,
  designation: DesignationValue,
): Promise<DocumentWithLive | null> {
  const [row] = await withLive(db, and(eq(decorDocuments.designation, designation), live));
  return row ?? null;
}

/** Id, kind and live pointer of each live document among `ids`, for link checks. */
export async function findDocumentStates(
  db: DbOrTx,
  ids: readonly number[],
): Promise<{ id: number; kind: DocumentKindValue; publishedRevisionId: number | null }[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: decorDocuments.id,
      kind: decorDocuments.kind,
      publishedRevisionId: decorDocuments.publishedRevisionId,
    })
    .from(decorDocuments)
    .where(and(inArray(decorDocuments.id, [...ids]), live));
}

/** Row-locks a live document for the rest of the transaction. */
export async function lockDocument(tx: Tx, id: number): Promise<DocumentRow | null> {
  const rows = await tx
    .select()
    .from(decorDocuments)
    .where(and(eq(decorDocuments.id, id), live))
    .for('update');
  return rows[0] ?? null;
}

export async function insertDocument(
  db: DbOrTx,
  values: {
    kind: DocumentKindValue;
    name: string;
    title: string;
    draft: Record<string, unknown>;
    createdByAdminId: number | null;
    now: Date;
  },
): Promise<DocumentRow> {
  const [row] = await db
    .insert(decorDocuments)
    .values({ ...values, createdAt: values.now, updatedAt: values.now })
    .returning();
  if (!row) throw new Error('decor: insert returned no row');
  return row;
}

export async function renameDocument(
  db: DbOrTx,
  id: number,
  name: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(decorDocuments)
    .set({ name, updatedAt: now })
    .where(and(eq(decorDocuments.id, id), live))
    .returning({ id: decorDocuments.id });
  return rows.length > 0;
}

/**
 * The optimistic-lock write (DECOR-010): succeeds only while the draft is
 * still at `expectedVersion`, and bumps it. `null` when the guard failed.
 */
export async function saveDraft(
  db: DbOrTx,
  input: {
    id: number;
    expectedVersion: number;
    draft: Record<string, unknown>;
    title: string;
    now: Date;
  },
): Promise<DocumentRow | null> {
  const rows = await db
    .update(decorDocuments)
    .set({
      draft: input.draft,
      title: input.title,
      draftVersion: sql`${decorDocuments.draftVersion} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(decorDocuments.id, input.id),
        eq(decorDocuments.draftVersion, input.expectedVersion),
        live,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Soft-deletes a live document that holds no designation (DECOR-009). */
export async function softDeleteUndesignated(db: DbOrTx, id: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(decorDocuments)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(decorDocuments.id, id), live, isNull(decorDocuments.designation)))
    .returning({ id: decorDocuments.id });
  return rows.length > 0;
}

export async function nextRevisionNumber(tx: Tx, documentId: number): Promise<number> {
  const [row] = await tx
    .select({ value: max(decorRevisions.number) })
    .from(decorRevisions)
    .where(eq(decorRevisions.documentId, documentId));
  return (row?.value ?? 0) + 1;
}

export async function insertRevision(
  tx: Tx,
  values: {
    documentId: number;
    number: number;
    content: Record<string, unknown>;
    authorAdminId: number | null;
    note: string;
    restoredFrom: number | null;
    now: Date;
  },
): Promise<RevisionRow> {
  const { now, ...rest } = values;
  const [row] = await tx
    .insert(decorRevisions)
    .values({ ...rest, createdAt: now })
    .returning();
  if (!row) throw new Error('decor: revision insert returned no row');
  return row;
}

/** Points the document at `revisionId`; `publishedDraftVersion` is `null` for a rollback. */
export async function setLive(
  tx: Tx,
  input: { id: number; revisionId: number; publishedDraftVersion: number | null; now: Date },
): Promise<DocumentRow> {
  const [row] = await tx
    .update(decorDocuments)
    .set({
      publishedRevisionId: input.revisionId,
      publishedDraftVersion: input.publishedDraftVersion,
      updatedAt: input.now,
    })
    .where(eq(decorDocuments.id, input.id))
    .returning();
  if (!row) throw new Error('decor: document vanished under its row lock');
  return row;
}

export async function listRevisions(
  db: DbOrTx,
  documentId: number,
): Promise<Omit<RevisionRow, 'content'>[]> {
  return db
    .select(revisionSummaryColumns)
    .from(decorRevisions)
    .where(eq(decorRevisions.documentId, documentId))
    .orderBy(desc(decorRevisions.number));
}

export async function findRevisionByNumber(
  db: DbOrTx,
  documentId: number,
  number: number,
): Promise<RevisionRow | null> {
  const rows = await db
    .select()
    .from(decorRevisions)
    .where(and(eq(decorRevisions.documentId, documentId), eq(decorRevisions.number, number)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findRevision(db: DbOrTx, id: number): Promise<RevisionRow | null> {
  const rows = await db.select().from(decorRevisions).where(eq(decorRevisions.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Serialises every change to one designation for the rest of the
 * transaction (DECOR-008). The partial unique index is the backstop; the lock
 * turns a race into a queue instead of a constraint error.
 */
export async function lockDesignation(tx: Tx, designation: DesignationValue): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`decor-designation:${designation}`}, 0))`,
  );
}

/** Takes `designation` away from every live document but `keepId`. */
export async function clearDesignation(
  tx: Tx,
  designation: DesignationValue,
  keepId: number | null,
  now: Date,
): Promise<void> {
  await tx
    .update(decorDocuments)
    .set({ designation: null, updatedAt: now })
    .where(
      and(
        eq(decorDocuments.designation, designation),
        keepId === null ? undefined : ne(decorDocuments.id, keepId),
      ),
    );
}

export async function setDesignation(
  tx: Tx,
  id: number,
  designation: DesignationValue,
  now: Date,
): Promise<void> {
  await tx
    .update(decorDocuments)
    .set({ designation, updatedAt: now })
    .where(eq(decorDocuments.id, id));
}
