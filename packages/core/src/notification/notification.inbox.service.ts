import type {
  MarkReadResult,
  NotificationMessage,
  NotificationMessageListQuery,
  UnreadCount,
} from '@shop/contracts/notification/schemas';
import { requireAdminId, requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { toId } from '../kernel/ids';
import * as repo from './notification.repo';

/**
 * The two inboxes — the shopper's 站内信 and the admin's bell — behind one set
 * of functions taking an audience.
 *
 * They really are the same feature: a list, an unread count, mark-read,
 * mark-all-read. Written twice, they would drift apart in the one way that
 * matters — a count that marks things seen as a side effect makes two open tabs
 * lose the badge.
 *
 * **Reading never mutates.** Only `markRead` and `markAllRead` write, and both
 * answer with how many rows they actually changed, so a double tap is a visible
 * `0` rather than an invented success.
 */

type Audience = 'user' | 'admin';

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function recipient(ctx: Ctx, audience: Audience): number {
  return audience === 'user' ? requireUserId(ctx) : requireAdminId(ctx);
}

export async function list(
  ctx: Ctx,
  audience: Audience,
  query: NotificationMessageListQuery,
): Promise<Paged<NotificationMessage>> {
  const { rows, total } = await repo.listMessages(ctx.db, {
    audience,
    recipientId: recipient(ctx, audience),
    ...(query.unreadOnly === undefined ? {} : { unreadOnly: query.unreadOnly }),
    ...(query.code === undefined ? {} : { code: query.code }),
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return { items: rows.map(toMessage), total, page: query.page, pageSize: query.pageSize };
}

export async function unreadCount(ctx: Ctx, audience: Audience): Promise<UnreadCount> {
  return {
    unread: await repo.countUnread(ctx.db, {
      audience,
      recipientId: recipient(ctx, audience),
    }),
  };
}

/**
 * A row that belongs to somebody else answers 404, never 403.
 *
 * 403 would confirm that the id exists, which turns a sequential id space into
 * a way of counting other people's messages. The `WHERE` carries the owner, so
 * the distinction never has to be made in code.
 */
export async function detail(
  ctx: Ctx,
  audience: Audience,
  input: { id: string },
): Promise<NotificationMessage> {
  const row = await repo.findMessage(ctx.db, {
    id: Number(input.id),
    audience,
    recipientId: recipient(ctx, audience),
  });
  if (!row) throw new DomainError('NOTIFICATION_MESSAGE_NOT_FOUND');
  return toMessage(row);
}

export async function markRead(
  ctx: Ctx,
  audience: Audience,
  input: { id: string },
): Promise<MarkReadResult> {
  const recipientId = recipient(ctx, audience);
  const { affected } = await repo.markRead(ctx.db, {
    id: Number(input.id),
    audience,
    recipientId,
    now: ctx.clock.now(),
  });
  if (affected === 0) {
    // Zero affected rows means "not yours", "already read" or "deleted", and
    // the update genuinely cannot tell them apart. Only the first is an error,
    // so ask once more whether the row is visible at all.
    const row = await repo.findMessage(ctx.db, { id: Number(input.id), audience, recipientId });
    if (!row) throw new DomainError('NOTIFICATION_MESSAGE_NOT_FOUND');
  }
  return { marked: affected };
}

export async function markAllRead(ctx: Ctx, audience: Audience): Promise<MarkReadResult> {
  const { affected } = await repo.markAllRead(ctx.db, {
    audience,
    recipientId: recipient(ctx, audience),
    now: ctx.clock.now(),
  });
  return { marked: affected };
}

/** Soft delete of this person's copy; the send record an operator reads survives. */
export async function remove(ctx: Ctx, audience: Audience, input: { id: string }): Promise<void> {
  const { won } = await repo.softDeleteMessage(ctx.db, {
    id: Number(input.id),
    audience,
    recipientId: recipient(ctx, audience),
    now: ctx.clock.now(),
  });
  if (!won) throw new DomainError('NOTIFICATION_MESSAGE_NOT_FOUND');
}

function toMessage(row: repo.MessageRow): NotificationMessage {
  return {
    id: toId(row.id),
    code: row.code,
    title: row.title,
    content: row.content,
    data: row.data,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
