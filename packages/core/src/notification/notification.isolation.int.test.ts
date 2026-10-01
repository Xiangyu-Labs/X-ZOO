import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { notificationMessages } from '@shop/db/schema/notification';
import { effects } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import * as admin from './notification.admin.service';
import { NOTIFICATION_SCOPE } from './notification.service';
import * as inbox from './notification.inbox.service';

/**
 * The two inboxes, read as somebody walking the id space.
 *
 * Message ids are sequential, and every per-message call — read, mark-read,
 * delete — takes one from the URL. The property is that another person's row
 * answers exactly like a row that does not exist, and is left untouched.
 *
 * The one write on 通知发送记录 is 重试, and it must not become a way to send a
 * delivered notification (an SMS, a template message) again.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
});

let sequence = 0;

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `inbox-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

async function makeAdmin(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({
      account: `admin-${sequence}`,
      passwordHash: 'x',
      passwordAlgo: 'bcrypt',
      name: `管理员${sequence}`,
    })
    .returning({ id: admins.id });
  return row!.id;
}

async function message(to: { userId: number } | { adminId: number }): Promise<string> {
  const [row] = await harness.ctx.db
    .insert(notificationMessages)
    .values({
      audience: 'userId' in to ? 'user' : 'admin',
      ...to,
      title: '订单已发货',
      content: '收件人 张三 13800000000',
    })
    .returning({ id: notificationMessages.id });
  return String(row!.id);
}

function asUser(id: number): Ctx {
  const actor: Actor = { kind: 'user', id, permissions: [], isSuper: false };
  return harness.as(actor);
}

function asAdmin(id: number): Ctx {
  const actor: Actor = { kind: 'admin', id, permissions: [], isSuper: false };
  return harness.as(actor);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'resolved';
}

async function untouched(id: string): Promise<boolean> {
  const [row] = await harness.ctx.db
    .select()
    .from(notificationMessages)
    .where(eq(notificationMessages.id, Number(id)));
  return row !== undefined && row.readAt === null && row.deletedAt === null;
}

describe('another person’s message', () => {
  it('answers a shopper’s id to another shopper as not found, on every call', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const id = await message({ userId: owner });

    const as = asUser(stranger);
    expect(await codeOf(inbox.detail(as, 'user', { id }))).toBe('NOTIFICATION_MESSAGE_NOT_FOUND');
    expect(await codeOf(inbox.markRead(as, 'user', { id }))).toBe('NOTIFICATION_MESSAGE_NOT_FOUND');
    expect(await codeOf(inbox.remove(as, 'user', { id }))).toBe('NOTIFICATION_MESSAGE_NOT_FOUND');
    expect(await inbox.markAllRead(as, 'user')).toEqual({ marked: 0 });
    expect((await inbox.list(as, 'user', { page: 1, pageSize: 20 })).total).toBe(0);
    expect(await untouched(id)).toBe(true);
  });

  it('answers one admin’s bell message to another admin as not found', async () => {
    const owner = await makeAdmin();
    const colleague = await makeAdmin();
    const id = await message({ adminId: owner });

    const as = asAdmin(colleague);
    expect(await codeOf(inbox.detail(as, 'admin', { id }))).toBe('NOTIFICATION_MESSAGE_NOT_FOUND');
    expect(await codeOf(inbox.markRead(as, 'admin', { id }))).toBe(
      'NOTIFICATION_MESSAGE_NOT_FOUND',
    );
    expect(await inbox.markAllRead(as, 'admin')).toEqual({ marked: 0 });
    expect(await untouched(id)).toBe(true);
  });

  it('never serves an admin-audience row to a shopper whose id happens to match', async () => {
    // Ids are per table, so shopper 1 and admin 1 both exist on every shop.
    const shopper = await makeUser();
    const admin = await makeAdmin();
    const id = await message({ adminId: admin });

    expect(shopper).toBe(admin);
    expect(await codeOf(inbox.detail(asUser(shopper), 'user', { id }))).toBe(
      'NOTIFICATION_MESSAGE_NOT_FOUND',
    );
    expect(await untouched(id)).toBe(true);
  });
});

async function sendRecord(
  status: 'done' | 'unknown',
  overrides: { scope?: string; scopeId?: string; payload?: unknown } = {},
): Promise<string> {
  const [row] = await harness.ctx.db
    .insert(effects)
    .values({
      scope: overrides.scope ?? NOTIFICATION_SCOPE,
      scopeId: overrides.scopeId ?? `order.shipped:${++sequence}`,
      eventType: 'notification.send',
      payload: overrides.payload ?? {},
      status,
    })
    .returning({ id: effects.id });
  return String(row!.id);
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await harness.ctx.db
    .select()
    .from(effects)
    .where(eq(effects.id, Number(id)));
  return row?.status;
}

describe('重试 on a send record', () => {
  const handler = (): Ctx =>
    harness.as({ kind: 'admin', id: 1, permissions: ['notification:log:handle'], isSuper: false });

  it('will not send a delivered notification a second time', async () => {
    const id = await sendRecord('done');
    const result = await admin.retryLog(handler(), { id });
    expect(result.succeeded).toBe(false);
    expect(result.message).toBe('该发送记录已经执行成功，不需要再重试');
    expect(await statusOf(id)).toBe('done');
  });

  it('requeues only a record whose outcome is unknown', async () => {
    const id = await sendRecord('unknown');
    const result = await admin.retryLog(handler(), { id });
    expect(result.succeeded).toBe(true);
    expect(await statusOf(id)).toBe('pending');

    // Pressing it again says the row is already on its way, not 已重新排队 twice.
    const again = await admin.retryLog(handler(), { id });
    expect(again.succeeded).toBe(false);
    expect(again.message).toBe('该发送记录已经在排队执行中，不需要再重试');
    expect(await statusOf(id)).toBe('pending');
  });

  it('answers another console’s row as not found, and leaves it parked', async () => {
    const id = await sendRecord('unknown', { scope: 'refund', scopeId: '42' });
    expect(await codeOf(admin.retryLog(handler(), { id }))).toBe('NOT_FOUND');
    expect(await statusOf(id)).toBe('unknown');
  });

  it('needs the handle atom, not the read one', async () => {
    const id = await sendRecord('unknown');
    const reader = harness.as({
      kind: 'admin',
      id: 1,
      permissions: ['notification:log:read'],
      isSuper: false,
    });
    expect(await codeOf(admin.retryLog(reader, { id }))).toBe('FORBIDDEN');
    expect(await statusOf(id)).toBe('unknown');
  });
});

describe('通知发送记录', () => {
  const reader = (): Ctx =>
    harness.as({ kind: 'admin', id: 1, permissions: ['notification:log:read'], isSuper: false });
  const page = { page: 1, pageSize: 20 };

  it('lists only the notification scope', async () => {
    await sendRecord('unknown', { scope: 'refund', scopeId: '42' });
    const mine = await sendRecord('unknown');

    const result = await admin.listLogs(reader(), { status: 'unknown', ...page });
    expect(result.items.map((item) => item.id)).toEqual([mine]);
    expect(result.total).toBe(1);
  });

  it('narrows to one event code, and not to codes that merely start the same way', async () => {
    const shipped = await sendRecord('done', { scopeId: 'order.shipped:order:1' });
    await sendRecord('done', { scopeId: 'order.shipped_admin:order:1' });

    const result = await admin.listLogs(reader(), {
      status: 'done',
      code: 'order.shipped',
      ...page,
    });
    expect(result.items.map((item) => item.id)).toEqual([shipped]);
    expect(result.items[0]).toMatchObject({ code: 'order.shipped', subject: 'order:1' });
  });
});
