import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  unique,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, pk, updatedAt } from './_shared';

/**
 * Page decoration v2 (`decor`, plan §2.1). It replaced the legacy `diy_pages`
 * tables, which were dropped at the cutover (migration `0008_drop_legacy_diy`).
 *
 * A **document** is one decorated page with one editable draft. Publishing
 * copies the draft into an immutable, numbered **revision** and points the
 * document at it; the storefront only ever serves revisions. A rollback
 * publishes an old revision's content again as a new revision, so history is
 * append-only and "what was live when" is always answerable.
 *
 * The JSON in `draft` and `content` is the v2 page document owned by
 * `contracts/src/decor/document.ts`; nothing in the database interprets it.
 */

export const decorDocumentsKind = pgEnum('decor_documents_kind', ['home', 'user_center', 'custom']);

/** What a document serves as. At most one live document per value. */
export const decorDesignation = pgEnum('decor_designation', ['home', 'user_center']);

export const decorDocuments = pgTable(
  'decor_documents',
  {
    id: pk(),
    kind: decorDocumentsKind().notNull(),
    /** Admin-facing name, 「国庆首页」. */
    name: varchar({ length: 50 }).notNull(),
    /** Copy of the draft's `root.props.title`, for lists and search. */
    title: varchar({ length: 30 }).notNull().default(''),
    draft: jsonb().$type<Record<string, unknown>>().notNull(),
    /**
     * Optimistic-lock token of the draft: every save is
     * `update … where draft_version = $expected` and bumps it.
     */
    draftVersion: integer().notNull().default(1),
    /** The live revision. Composite FK below: it must be one of this document's revisions. */
    publishedRevisionId: fk(),
    /** The draft version that revision was published from; `null` after a rollback. */
    publishedDraftVersion: integer(),
    designation: decorDesignation(),
    /** The admin who created it; not a foreign key, so removing an admin rewrites nothing. */
    createdByAdminId: fk(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('decor_documents_kind_idx')
      .on(t.kind, t.updatedAt)
      .where(sql`deleted_at is null`),
    // One home and one user centre, enforced by the database (DECOR-008).
    uniqueIndex('decor_documents_designation_uq')
      .on(t.designation)
      .where(sql`designation is not null and deleted_at is null`),
    check('decor_documents_draft_version_positive', sql`${t.draftVersion} >= 1`),
    check(
      'decor_documents_designation_kind',
      sql`${t.designation} is null or ${t.designation}::text = ${t.kind}::text`,
    ),
    check(
      'decor_documents_designation_published',
      sql`${t.designation} is null or ${t.publishedRevisionId} is not null`,
    ),
    check(
      'decor_documents_designation_live',
      sql`${t.designation} is null or ${t.deletedAt} is null`,
    ),
    foreignKey({
      name: 'decor_documents_published_revision_fk',
      columns: [t.id, t.publishedRevisionId],
      foreignColumns: [decorRevisions.documentId, decorRevisions.id],
    }),
  ],
);

export type DecorDocument = typeof decorDocuments.$inferSelect;
export type NewDecorDocument = typeof decorDocuments.$inferInsert;

/**
 * Published content, append-only. A trigger (migration 0004) refuses UPDATE
 * and DELETE, so no code path can rewrite what was once live (DECOR-006).
 */
export const decorRevisions = pgTable(
  'decor_revisions',
  {
    id: pk(),
    documentId: fk()
      .notNull()
      .references((): AnyPgColumn => decorDocuments.id, { onDelete: 'restrict' }),
    /** 1, 2, 3 … per document, in publish order. */
    number: integer().notNull(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    /** The publishing admin at the time; not a foreign key (the row never changes). */
    authorAdminId: fk(),
    note: varchar({ length: 200 }).notNull().default(''),
    /** A rollback: the revision number whose content this republishes. */
    restoredFrom: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('decor_revisions_number_uq').on(t.documentId, t.number),
    // Target of the documents' composite FK.
    unique('decor_revisions_document_id_uq').on(t.documentId, t.id),
    check('decor_revisions_number_positive', sql`${t.number} >= 1`),
    check(
      'decor_revisions_restored_from_earlier',
      sql`${t.restoredFrom} is null or (${t.restoredFrom} >= 1 and ${t.restoredFrom} < ${t.number})`,
    ),
  ],
);

export type DecorRevision = typeof decorRevisions.$inferSelect;
export type NewDecorRevision = typeof decorRevisions.$inferInsert;
