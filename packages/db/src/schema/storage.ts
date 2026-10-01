import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, pk, updatedAt } from './_shared';
import { admins } from './auth';
import { users } from './user';

/**
 * The media library.
 *
 * The storage key is always generated on the server. Nothing here ever accepts
 * a client-supplied path: a client that chooses the path can overwrite any
 * file the server can write.
 */

export const attachmentCategories = pgTable(
  'attachment_categories',
  {
    id: pk(),
    parentId: fk().references((): AnyPgColumn => attachmentCategories.id, {
      onDelete: 'restrict',
    }),
    name: varchar({ length: 64 }).notNull(),
    /** Materialised ancestor path, `/1/7/`. Root categories have `/`. */
    path: varchar({ length: 255 }).notNull().default('/'),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('attachment_categories_parent_idx').on(t.parentId),
    index('attachment_categories_path_idx').on(t.path),
  ],
);

export type AttachmentCategory = typeof attachmentCategories.$inferSelect;
export type NewAttachmentCategory = typeof attachmentCategories.$inferInsert;

export const attachmentsDriver = pgEnum('attachments_driver', ['local', 's3']);

export const attachmentsKind = pgEnum('attachments_kind', ['image', 'video', 'audio', 'file']);

export const attachments = pgTable(
  'attachments',
  {
    id: pk(),
    categoryId: fk().references(() => attachmentCategories.id, { onDelete: 'set null' }),
    /**
     * Server-generated object key, e.g. `2026/09/21/8f3c…d1.webp`. Unique across
     * drivers; the public URL is derived from it plus the driver's base.
     */
    storageKey: varchar({ length: 512 }).notNull(),
    driver: attachmentsDriver().notNull(),
    /** S3 bucket, or NULL for the local driver. */
    bucket: varchar({ length: 128 }),
    /** Renderable absolute or site-relative URL. */
    url: text().notNull(),
    /** Display name in the library. Editable. */
    name: varchar({ length: 255 }).notNull(),
    /** The client's original filename, kept for download and audit only. */
    originalName: varchar({ length: 255 }),
    kind: attachmentsKind().notNull(),
    mime: varchar({ length: 128 }).notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    /** Lower-case hex SHA-256 of the stored bytes. Indexed, not unique: the same bytes may be stored twice. */
    sha256: varchar({ length: 64 }).notNull(),
    width: integer(),
    height: integer(),
    durationMs: integer(),
    thumbnailUrl: text(),
    uploadedByAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    uploadedByUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('attachments_storage_key_uq').on(t.storageKey),
    index('attachments_category_idx').on(t.categoryId),
    index('attachments_sha256_idx').on(t.sha256),
    index('attachments_created_at_idx').on(t.createdAt),
    /**
     * "Is this URL one of ours?" — `PUT /api/v1/profile` accepts an avatar only
     * from our own storage. Hash, not btree: equality is the only question and
     * a URL has no length a btree entry is guaranteed to fit.
     */
    index('attachments_url_idx').using('hash', t.url),
    check('attachments_size_non_negative', sql`${t.size} >= 0`),
    check(
      'attachments_dimensions_non_negative',
      sql`(${t.width} is null or ${t.width} > 0) and (${t.height} is null or ${t.height} > 0) and (${t.durationMs} is null or ${t.durationMs} >= 0)`,
    ),
    check('attachments_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
