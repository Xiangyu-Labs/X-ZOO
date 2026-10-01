import type { DbOrTx, Tx } from '@shop/db';
import { adminRoles, admins, rolePermissions, roles } from '@shop/db/schema/auth';
import {
  notificationMessages,
  notificationTemplates,
  type NotificationChannels,
  type NotificationTemplate,
} from '@shop/db/schema/notification';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * Re-exported from here on purpose.
 *
 * `boundaries/no-restricted-source` lets only a `*.repo.ts` import
 * `@shop/db/schema/*`, and it does not distinguish a type-only import — rightly,
 * since the exemption is about who may know the table's shape. The services need
 * the *shape* of the `channels` column, so the repo publishes it rather than
 * every service reaching past the rule.
 */
export type { NotificationChannels };

/**
 * Statements, not decisions.
 *
 * Two things in this file are load-bearing:
 *
 * - **`markRead` and `markAllRead` are conditional updates with the owner and
 *   the read state in the `WHERE`.** `affected` is how the service learns that
 *   the message was already read (and answers `{ marked: 0 }`) without a prior
 *   `SELECT` that would prove nothing about the instant of the write. It is
 *   also why a message belonging to somebody else cannot be marked read by
 *   guessing its id.
 * - **`upsertTemplate` is `ON CONFLICT DO UPDATE`.** The registry is the source
 *   of truth for which events exist, so reading the admin list seeds any row
 *   that is missing; two admins opening the screen at the same moment must not
 *   produce a unique violation.
 */

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

export async function findTemplate(
  db: DbOrTx,
  code: string,
): Promise<NotificationTemplate | undefined> {
  const rows = await db
    .select()
    .from(notificationTemplates)
    .where(eq(notificationTemplates.code, code))
    .limit(1);
  return rows[0];
}

export async function listTemplates(
  db: DbOrTx,
  codes: readonly string[],
): Promise<NotificationTemplate[]> {
  if (codes.length === 0) return [];
  return db
    .select()
    .from(notificationTemplates)
    .where(inArray(notificationTemplates.code, [...codes]));
}

export interface TemplateSeed {
  code: string;
  name: string;
  description: string | null;
  audience: 'user' | 'admin';
  channels: NotificationChannels;
  variables: string[];
}

/**
 * Seeds rows the registry declares and the table does not have yet.
 *
 * `DO UPDATE` on the descriptive columns only — the name and the variable list
 * come from the code and may legitimately change with a deploy — while
 * `channels` and `is_enabled` are left alone, because those are the operator's.
 */
export async function upsertTemplates(tx: Tx, seeds: readonly TemplateSeed[]): Promise<void> {
  if (seeds.length === 0) return;
  await tx
    .insert(notificationTemplates)
    .values(
      seeds.map((seed) => ({
        code: seed.code,
        name: seed.name,
        description: seed.description,
        audience: seed.audience,
        channels: seed.channels,
        variables: seed.variables,
      })),
    )
    .onConflictDoUpdate({
      target: notificationTemplates.code,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        audience: sql`excluded.audience`,
        variables: sql`excluded.variables`,
      },
    });
}

export async function saveTemplate(
  db: DbOrTx,
  code: string,
  patch: { channels: NotificationChannels; isEnabled: boolean; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, notificationTemplates, {
    where: eq(notificationTemplates.code, code),
    set: { channels: patch.channels, isEnabled: patch.isEnabled, updatedAt: patch.now },
  });
}

// ---------------------------------------------------------------------------
// recipients
// ---------------------------------------------------------------------------

/**
 * Admin ids that should receive an admin-audience event.
 *
 * Super admins always, plus anybody whose roles grant the event's atom. An
 * inactive or soft-deleted account is excluded here rather than filtered in the
 * bell, so a departed colleague's inbox stops filling up.
 *
 * `status = 1` is "enabled" (`schema/auth.ts`); without the filter every
 * disabled account keeps accruing 站内信.
 */
export async function findAdminRecipients(
  db: DbOrTx,
  permission: string,
): Promise<{ id: number }[]> {
  const granted = db
    .select({ adminId: adminRoles.adminId })
    .from(adminRoles)
    .innerJoin(roles, and(eq(roles.id, adminRoles.roleId), eq(roles.status, 1)))
    .innerJoin(
      rolePermissions,
      and(eq(rolePermissions.roleId, roles.id), eq(rolePermissions.permission, permission)),
    );

  return db
    .selectDistinct({ id: admins.id })
    .from(admins)
    .where(
      and(
        eq(admins.status, 1),
        isNull(admins.deletedAt),
        or(eq(admins.isSuper, true), inArray(admins.id, granted)),
      ),
    )
    .orderBy(asc(admins.id));
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export interface NewMessage {
  code: string;
  audience: 'user' | 'admin';
  userId?: number;
  adminId?: number;
  title: string;
  content: string;
  data: Record<string, unknown>;
}

/**
 * Inserts the in-app copies for one fan-out.
 *
 * Returns the inserted rows so the SSE producer can publish exactly what was
 * stored — publishing a separately-built object is how the bell and the inbox
 * come to disagree about a message's title.
 */
export async function insertMessages(
  tx: Tx,
  rows: readonly NewMessage[],
  now: Date,
): Promise<{ id: number; adminId: number | null; userId: number | null }[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(notificationMessages)
    .values(rows.map((row) => ({ ...row, createdAt: now })))
    .returning({
      id: notificationMessages.id,
      adminId: notificationMessages.adminId,
      userId: notificationMessages.userId,
    });
}

export interface MessageRow {
  id: number;
  code: string | null;
  title: string;
  content: string;
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
}

const messageColumns = {
  id: notificationMessages.id,
  code: notificationMessages.code,
  title: notificationMessages.title,
  content: notificationMessages.content,
  data: notificationMessages.data,
  readAt: notificationMessages.readAt,
  createdAt: notificationMessages.createdAt,
} as const;

export interface MessageFilter {
  audience: 'user' | 'admin';
  recipientId: number;
  unreadOnly?: boolean;
  code?: string;
  offset: number;
  limit: number;
}

function ownerOf(filter: { audience: 'user' | 'admin'; recipientId: number }) {
  return filter.audience === 'user'
    ? eq(notificationMessages.userId, filter.recipientId)
    : eq(notificationMessages.adminId, filter.recipientId);
}

export async function listMessages(
  db: DbOrTx,
  filter: MessageFilter,
): Promise<{ rows: MessageRow[]; total: number }> {
  const where = allOf(
    eq(notificationMessages.audience, filter.audience),
    ownerOf(filter),
    isNull(notificationMessages.deletedAt),
    filter.unreadOnly === true ? isNull(notificationMessages.readAt) : undefined,
    filter.code === undefined ? undefined : eq(notificationMessages.code, filter.code),
  );

  const rows = await db
    .select(messageColumns)
    .from(notificationMessages)
    .where(where)
    .orderBy(desc(notificationMessages.createdAt), desc(notificationMessages.id))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notificationMessages)
    .where(where);

  return { rows: rows as MessageRow[], total: count?.total ?? 0 };
}

export async function findMessage(
  db: DbOrTx,
  args: { id: number; audience: 'user' | 'admin'; recipientId: number },
): Promise<MessageRow | undefined> {
  const rows = await db
    .select(messageColumns)
    .from(notificationMessages)
    .where(
      and(
        eq(notificationMessages.id, args.id),
        eq(notificationMessages.audience, args.audience),
        ownerOf({ audience: args.audience, recipientId: args.recipientId }),
        isNull(notificationMessages.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] as MessageRow | undefined;
}

export async function countUnread(
  db: DbOrTx,
  args: { audience: 'user' | 'admin'; recipientId: number },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notificationMessages)
    .where(
      and(
        eq(notificationMessages.audience, args.audience),
        ownerOf(args),
        isNull(notificationMessages.readAt),
        isNull(notificationMessages.deletedAt),
      ),
    );
  return row?.total ?? 0;
}

/**
 * One conditional update carrying the owner, the soft-delete and the read state.
 * `affected === 0` means "not yours, gone, or already read" — three answers the
 * caller does not need to tell apart, and cannot tell apart honestly anyway.
 */
export async function markRead(
  db: DbOrTx,
  args: { id: number; audience: 'user' | 'admin'; recipientId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, notificationMessages, {
    where: and(
      eq(notificationMessages.id, args.id),
      eq(notificationMessages.audience, args.audience),
      ownerOf(args),
      isNull(notificationMessages.readAt),
      isNull(notificationMessages.deletedAt),
    ),
    set: { readAt: args.now },
  });
}

export async function markAllRead(
  db: DbOrTx,
  args: { audience: 'user' | 'admin'; recipientId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, notificationMessages, {
    where: and(
      eq(notificationMessages.audience, args.audience),
      ownerOf(args),
      isNull(notificationMessages.readAt),
      isNull(notificationMessages.deletedAt),
    ),
    set: { readAt: args.now },
  });
}

/** Soft delete of this person's copy — the send record an operator reads survives. */
export async function softDeleteMessage(
  db: DbOrTx,
  args: { id: number; audience: 'user' | 'admin'; recipientId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, notificationMessages, {
    where: and(
      eq(notificationMessages.id, args.id),
      eq(notificationMessages.audience, args.audience),
      ownerOf(args),
      isNull(notificationMessages.deletedAt),
    ),
    set: { deletedAt: args.now },
  });
}

/** Exists so an integration test can prove the fan-out wrote exactly once. */
export async function countMessagesFor(
  db: DbOrTx,
  args: { code: string; audience: 'user' | 'admin' },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(notificationMessages)
    .where(
      and(
        eq(notificationMessages.code, args.code),
        eq(notificationMessages.audience, args.audience),
      ),
    );
  return row?.total ?? 0;
}
