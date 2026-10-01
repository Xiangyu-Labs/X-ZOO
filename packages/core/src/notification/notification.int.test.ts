import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins, adminRoles, rolePermissions, roles } from '@shop/db/schema/auth';
import { notificationMessages, notificationTemplates } from '@shop/db/schema/notification';
import { effects as effectsTable } from '@shop/db/schema/system';
import { users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { dispatchEffectsOnce, findEffect, listEffectsByStatus } from '../effects';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { withTx } from '../kernel/tx';
import * as notificationAdmin from './notification.admin.service';
import { registerBuiltInNotificationEvents } from './notification.registry';
import { fakeSmsSender, registerSmsSender, resetSmsSender } from '../sms';
import {
  registerDefaultSmsPort,
  registerSmsPort,
  resetNotificationPorts,
  type SmsPort,
} from './notification.ports';
import { providerSmsPort } from './notification.sms';
import { adminChannel, subscribeToAdmin } from './notification.stream';
import { notify, NOTIFICATION_EVENT_TYPE, NOTIFICATION_SCOPE } from './notification.service';
// Imported for its side effect: the module registers the `notification.send`
// effect handler at import time, which is what the dispatcher looks up.
import './notification.effects';

/**
 * The three promises this domain makes to every other one.
 *
 * 1. A channel that fails never fails the business transaction, and is retried.
 * 2. The same event for the same aggregate notifies **once**, however many
 *    callers ask and however many dispatchers are running.
 * 3. An admin notification reaches the admins who may see it, over SSE, and
 *    only them.
 *
 * Everything here runs against the real PostgreSQL and the real Redis. The only
 * fake is the SMS port, a seam onto the `sms` domain — no test in this file
 * calls a WeChat or SMS endpoint, and the WeChat channels stay unconfigured so
 * they are skipped rather than attempted.
 */

let harness: TestCtx;
let sequence = 0;

beforeAll(async () => {
  harness = await createTestCtx();
  registerBuiltInNotificationEvents();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  resetNotificationPorts();
});

afterEach(() => {
  resetNotificationPorts();
});

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `notify-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

async function makeAdmin(options: { permissions?: string[]; isSuper?: boolean } = {}) {
  sequence += 1;
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account: `admin-${sequence}`,
      passwordHash: 'x',
      passwordAlgo: 'bcrypt',
      name: `管理员 ${sequence}`,
      isSuper: options.isSuper ?? false,
    })
    .returning({ id: admins.id });
  const adminId = admin!.id;

  if (options.permissions && options.permissions.length > 0) {
    const [role] = await harness.ctx.db
      .insert(roles)
      .values({ name: `role-${sequence}` })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(options.permissions.map((permission) => ({ roleId: role!.id, permission })));
  }
  return adminId;
}

/** `notify` as a domain calls it: inside a transaction that also does real work. */
async function record(input: {
  event: string;
  subject: { scope: string; id: string | number };
  userId?: number;
  data?: Record<string, unknown>;
}): Promise<boolean> {
  return withTx(harness.ctx.db, (tx) => notify(tx, harness.ctx, input));
}

async function messagesFor(column: 'userId' | 'adminId', id: number) {
  return harness.ctx.db
    .select()
    .from(notificationMessages)
    .where(eq(notificationMessages[column], id));
}

/** Turns a channel on for one event, after the first fan-out seeded the row. */
async function enableSms(
  code: string,
  templateCode = 'SMS_1',
  params?: { name: string; value: string }[],
): Promise<void> {
  const [row] = await harness.ctx.db
    .select()
    .from(notificationTemplates)
    .where(eq(notificationTemplates.code, code));
  await harness.ctx.db
    .update(notificationTemplates)
    .set({
      channels: {
        ...row!.channels,
        sms: { enabled: true, templateCode, ...(params ? { params } : {}) },
      },
    })
    .where(eq(notificationTemplates.code, code));
}

function smsPort(
  behaviour: () => { ok: boolean; errorCode?: string },
): SmsPort & { calls: number } {
  const port = {
    calls: 0,
    async send() {
      port.calls += 1;
      return behaviour();
    },
  };
  return port;
}

describe('notify', () => {
  it('writes an effect row inside the caller transaction and sends nothing yet', async () => {
    const userId = await makeUser();
    expect(await record({ event: 'order_paid', subject: { scope: 'order', id: 7 }, userId })).toBe(
      true,
    );

    const effect = await findEffect(harness.ctx.db, {
      scope: NOTIFICATION_SCOPE,
      scopeId: 'order_paid:order:7',
      eventType: NOTIFICATION_EVENT_TYPE,
    });
    expect(effect).toMatchObject({ status: 'pending' });
    expect(await messagesFor('userId', userId)).toHaveLength(0);
  });

  it('is rolled back with the business change it belongs to', async () => {
    const userId = await makeUser();
    await expect(
      withTx(harness.ctx.db, async (tx) => {
        await notify(tx, harness.ctx, {
          event: 'order_paid',
          subject: { scope: 'order', id: 8 },
          userId,
        });
        throw new Error('支付失败');
      }),
    ).rejects.toThrow('支付失败');
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(0);
  });

  it('drops an event nobody registered rather than failing the order', async () => {
    const userId = await makeUser();
    expect(
      await record({ event: 'no_such_event', subject: { scope: 'order', id: 9 }, userId }),
    ).toBe(false);
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(0);
  });

  it('records the same event for the same aggregate once, twice for two aggregates', async () => {
    const userId = await makeUser();
    expect(await record({ event: 'order_paid', subject: { scope: 'order', id: 1 }, userId })).toBe(
      true,
    );
    expect(await record({ event: 'order_paid', subject: { scope: 'order', id: 1 }, userId })).toBe(
      false,
    );
    expect(await record({ event: 'order_paid', subject: { scope: 'order', id: 2 }, userId })).toBe(
      true,
    );
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(2);
  });
});

describe('fan-out', () => {
  it('seeds the template from the registry and writes the in-app message — NOTIF-006', async () => {
    const userId = await makeUser();
    await record({
      event: 'order_paid',
      subject: { scope: 'order', id: 11 },
      userId,
      data: { orderNo: 'SO11', amount: '99.00', orderId: 11 },
    });

    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ claimed: 1, done: 1 });

    const [template] = await harness.ctx.db
      .select()
      .from(notificationTemplates)
      .where(eq(notificationTemplates.code, 'order_paid'));
    expect(template?.channels.inApp?.enabled).toBe(true);
    // Everything that costs money or needs a credential is seeded off.
    expect(template?.channels.sms?.enabled).toBe(false);
    expect(template?.channels.wechatOa?.enabled).toBe(false);

    const [message] = await messagesFor('userId', userId);
    expect(message).toMatchObject({ code: 'order_paid', audience: 'user', title: '支付成功' });
    expect(message?.content).toBe('订单 SO11 已支付 ¥99.00，我们会尽快发货。');
    expect(message?.data).toMatchObject({ route: { route: 'order', params: { id: '11' } } });
    expect(message?.data).not.toHaveProperty('link');
    expect(message?.readAt).toBeNull();
  });

  it('sends in-app from a template shell the reference-data seed wrote with no channels', async () => {
    // The row `db:seed` writes on every deploy: code, name, audience and
    // variables, and `channels` left at its `{}` default.
    await harness.ctx.db.insert(notificationTemplates).values({
      code: 'order_paid',
      name: '支付成功提醒',
      audience: 'user',
      variables: ['orderNo', 'amount', 'productName'],
    });
    const userId = await makeUser();
    await record({
      event: 'order_paid',
      subject: { scope: 'order', id: 14 },
      userId,
      data: { orderNo: 'SO14', amount: '10.00', orderId: 14 },
    });

    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ claimed: 1, done: 1 });
    const [message] = await messagesFor('userId', userId);
    expect(message?.content).toBe('订单 SO14 已支付 ¥10.00，我们会尽快发货。');
  });

  it('does not send at all when the operator turned the event off', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 12 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await harness.ctx.db
      .update(notificationTemplates)
      .set({ isEnabled: false })
      .where(eq(notificationTemplates.code, 'order_paid'));

    await record({ event: 'order_paid', subject: { scope: 'order', id: 13 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    expect(await messagesFor('userId', userId)).toHaveLength(1);
  });

  it('delivers the same notification once when two dispatchers race it', async () => {
    const userIds = await Promise.all([1, 2, 3, 4].map(() => makeUser()));
    for (const [index, userId] of userIds.entries()) {
      await record({ event: 'order_paid', subject: { scope: 'order', id: 100 + index }, userId });
    }

    const second = forkTestCtx(harness);
    const report = await runConcurrently(2, (index) =>
      dispatchEffectsOnce(index === 0 ? harness.ctx : second, { batchSize: 4 }),
    );
    expect(report.rejected).toEqual([]);

    // Four notifications, four inboxes, one message each — whichever dispatcher
    // claimed which row.
    for (const userId of userIds) {
      expect(await messagesFor('userId', userId)).toHaveLength(1);
    }
    expect(await listEffectsByStatus(harness.ctx.db, 'pending')).toHaveLength(0);
  });
});

describe('a channel that fails', () => {
  it('retries the effect, keeps the message it already delivered, and never duplicates it', async () => {
    const userId = await makeUser();

    // Seed the template by running one notification through, then switch SMS on.
    await record({ event: 'order_paid', subject: { scope: 'order', id: 20 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid');

    const failing = smsPort(() => ({ ok: false, errorCode: 'isv.BUSINESS_LIMIT_CONTROL' }));
    registerSmsPort(failing);

    // The business transaction commits regardless — `notify` only writes a row.
    await record({
      event: 'order_paid',
      subject: { scope: 'order', id: 21 },
      userId,
      data: { orderNo: 'SO21', amount: '10.00' },
    });

    const first = await dispatchEffectsOnce(harness.ctx);
    expect(first).toMatchObject({ claimed: 1, done: 0, retried: 1, parked: 0 });
    expect(failing.calls).toBe(1);

    const key = {
      scope: NOTIFICATION_SCOPE,
      scopeId: 'order_paid:order:21',
      eventType: NOTIFICATION_EVENT_TYPE,
    };
    const parked = await findEffect(harness.ctx.db, key);
    expect(parked).toMatchObject({ status: 'pending', attempts: 1 });
    expect(parked?.lastError ?? '').toContain('sms');
    // Staff read the channel in Chinese; the provider's words stay under 技术详情.
    expect(parked?.lastErrorSummary).toBe(
      '短信：该手机号收到的短信太多，被服务商限流（isv.BUSINESS_LIMIT_CONTROL）',
    );

    // The in-app copy went out on the first attempt and must not go out again.
    expect(await messagesFor('userId', userId)).toHaveLength(2);

    const working = smsPort(() => ({ ok: true }));
    registerSmsPort(working);
    harness.clock.advance(60_000);

    const second = await dispatchEffectsOnce(harness.ctx);
    expect(second).toMatchObject({ claimed: 1, done: 1 });
    expect(working.calls).toBe(1);
    expect((await findEffect(harness.ctx.db, key))?.status).toBe('done');
    // Still two: the retry re-sent only the channel that had not claimed.
    expect(await messagesFor('userId', userId)).toHaveLength(2);
  });

  it('skips, rather than fails, a channel no provider is wired for', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 22 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid');

    // No `registerSmsPort` at all — a shop with no SMS account is normal.
    await record({ event: 'order_paid', subject: { scope: 'order', id: 23 }, userId });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });
  });

  it('skips a channel the operator left unconfigured', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 24 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid', '');
    registerSmsPort(smsPort(() => ({ ok: false })));

    await record({ event: 'order_paid', subject: { scope: 'order', id: 25 }, userId });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });
  });
});

describe('the SMS channel, through the shop’s provider', () => {
  afterEach(() => {
    resetSmsSender();
  });

  async function makeUserWithPhone(phone: string | null): Promise<number> {
    const userId = await makeUser();
    await harness.ctx.db.update(users).set({ phone }).where(eq(users.id, userId));
    return userId;
  }

  it('sends exactly the template’s variables, in order, and none for a template without', async () => {
    const sms = fakeSmsSender();
    registerSmsSender(sms);
    registerDefaultSmsPort(providerSmsPort);
    const userId = await makeUserWithPhone('13800138000');

    await record({ event: 'order_paid', subject: { scope: 'order', id: 30 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    // A row saved before `params` existed reads as a template with no variables.
    await enableSms('order_paid', '520268');
    await record({
      event: 'order_paid',
      subject: { scope: 'order', id: 31 },
      userId,
      data: { orderId: 31, orderNo: 'SO31', amount: '10.00' },
    });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });

    await enableSms('order_paid', '520268', [
      { name: 'price', value: '{{amount}}' },
      { name: 'no', value: '{{orderNo}}' },
    ]);
    await record({
      event: 'order_paid',
      subject: { scope: 'order', id: 32 },
      userId,
      data: { orderId: 32, orderNo: 'SO32', amount: '12.00' },
    });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });

    expect(sms.sent).toEqual([
      { phone: '13800138000', templateId: '520268', params: [], signName: undefined },
      {
        phone: '13800138000',
        templateId: '520268',
        params: [
          { name: 'price', value: '12.00' },
          { name: 'no', value: 'SO32' },
        ],
        signName: undefined,
      },
    ]);
  });

  it('skips, rather than retries, a member with no phone and a shop with no provider', async () => {
    registerDefaultSmsPort(providerSmsPort);
    const withPhone = await makeUserWithPhone('13800138001');
    const noPhone = await makeUserWithPhone(null);
    await record({ event: 'order_paid', subject: { scope: 'order', id: 33 }, userId: withPhone });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid');

    // No provider in 短信设置, and no sender registered.
    await record({ event: 'order_paid', subject: { scope: 'order', id: 34 }, userId: withPhone });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });

    const sms = fakeSmsSender();
    registerSmsSender(sms);
    await record({ event: 'order_paid', subject: { scope: 'order', id: 35 }, userId: noPhone });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });
    expect(sms.sent).toEqual([]);
  });

  it('retries a provider refusal', async () => {
    const sms = fakeSmsSender();
    registerSmsSender(sms);
    registerDefaultSmsPort(providerSmsPort);
    const userId = await makeUserWithPhone('13800138002');
    await record({ event: 'order_paid', subject: { scope: 'order', id: 36 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid');

    sms.failNext(1, { providerCode: 'FailedOperation.TemplateParamSetNotMatchApprovedTemplate' });
    await record({ event: 'order_paid', subject: { scope: 'order', id: 37 }, userId });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 0, retried: 1 });
    const effect = await findEffect(harness.ctx.db, {
      scope: NOTIFICATION_SCOPE,
      scopeId: 'order_paid:order:37',
      eventType: NOTIFICATION_EVENT_TYPE,
    });
    expect(effect?.lastError ?? '').toContain('TemplateParamSetNotMatchApprovedTemplate');
  });
});

describe('admin fan-out and the SSE bell', () => {
  /** Collects what one admin's channel receives, the way the route handler does. */
  async function listen(adminId: number) {
    const received: string[] = [];
    const unsubscribe = await subscribeToAdmin(harness.redis, adminId, (raw) => {
      received.push(raw);
    });
    return { received, unsubscribe };
  }

  it('reaches every admin who may see the event, over SSE, and nobody else', async () => {
    // Sequentially: the seed counter that keeps the accounts' names unique is
    // not itself concurrency-safe, and this test is not about that.
    const orders1 = await makeAdmin({ permissions: ['order:order:read'] });
    const orders2 = await makeAdmin({ permissions: ['order:order:read'] });
    const warehouse = await makeAdmin({ permissions: ['catalog:product:read'] });

    const listeners = await Promise.all([listen(orders1), listen(orders2), listen(warehouse)]);

    await record({
      event: 'admin_order_paid',
      subject: { scope: 'order', id: 30 },
      data: { orderNo: 'SO30', amount: '5.00', orderId: 30 },
    });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1 });

    // Pub/Sub delivery is asynchronous; give the subscriber connections a turn.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(listeners[0]!.received).toHaveLength(1);
    expect(listeners[1]!.received).toHaveLength(1);
    // The atom is what decides. 库存 has no business being woken by an order.
    expect(listeners[2]!.received).toEqual([]);

    const payload = JSON.parse(listeners[0]!.received[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'admin_order_paid',
      title: '新的已付款订单',
      link: '/admin/orders/30',
    });
    expect(payload['body']).toBe('订单 SO30 已付款，金额 ¥5.00。');
    // The id is the durable row's, so the bell and the inbox agree.
    const stored = await messagesFor('adminId', orders1);
    expect(payload['id']).toBe(String(stored[0]!.id));

    expect(await messagesFor('adminId', warehouse)).toHaveLength(0);

    await Promise.all(listeners.map((listener) => listener.unsubscribe()));
  });

  it('reaches a super admin without any explicit grant', async () => {
    const superAdmin = await makeAdmin({ isSuper: true });
    await record({ event: 'admin_order_paid', subject: { scope: 'order', id: 31 } });
    await dispatchEffectsOnce(harness.ctx);
    expect(await messagesFor('adminId', superAdmin)).toHaveLength(1);
  });

  it('leaves a disabled account out, so a departed colleague stops accruing 站内信', async () => {
    const leaver = await makeAdmin({ permissions: ['order:order:read'] });
    await harness.ctx.db.update(admins).set({ status: 0 }).where(eq(admins.id, leaver));
    await makeAdmin({ permissions: ['order:order:read'] });

    await record({ event: 'admin_order_paid', subject: { scope: 'order', id: 32 } });
    await dispatchEffectsOnce(harness.ctx);
    expect(await messagesFor('adminId', leaver)).toHaveLength(0);
  });

  it('is done, not failed, when no account holds the event’s atom', async () => {
    await makeAdmin({ permissions: ['catalog:product:read'] });
    await record({ event: 'admin_refund_applied', subject: { scope: 'refund', id: 33 } });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1, retried: 0 });
    const rows = await harness.ctx.db.select().from(effectsTable);
    expect(rows[0]).toMatchObject({ status: 'done' });
  });

  it('publishes on one channel per admin', () => {
    expect(adminChannel(42)).toBe('notifications:admin:42');
  });
});

describe('NOTIF-013 — a template written around the save', () => {
  const superAdmin = (): Ctx =>
    harness.as({ kind: 'admin', id: 1, permissions: [], isSuper: true });

  /** What production had: rows edited in the database, never through 保存. */
  async function writeDirectly(code: string, channels: Record<string, unknown>): Promise<void> {
    await notificationAdmin.getTemplate(superAdmin(), { code });
    await harness.ctx.db
      .update(notificationTemplates)
      .set({ channels: channels as never })
      .where(eq(notificationTemplates.code, code));
  }

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(DomainError.is(error)).toBe(true);
    return error as DomainError;
  }

  it('lists a switch that is on and cannot send as such, not as on', async () => {
    await writeDirectly('order_shipped', {
      inApp: { enabled: true, title: '已发货', body: '订单 {{orderNo}}' },
      wechatMini: { enabled: true, templateKey: '1458' },
    });
    await writeDirectly('admin_order_paid', {
      inApp: { enabled: true, title: '新订单', body: '订单 {{orderNo}}' },
      sms: { enabled: true, templateCode: '' },
      wechatOa: { enabled: true, templateKey: '' },
    });

    const page = await notificationAdmin.listTemplates(superAdmin(), { page: 1, pageSize: 100 });
    const byCode = new Map(page.items.map((item) => [item.code, item]));
    expect(byCode.get('order_shipped')?.channelProblems).toEqual([
      {
        channel: 'wechatMini',
        kind: 'incomplete',
        missing: ['templateId', 'fields'],
        message: '已开启但无法发送：缺模板 ID、字段映射',
      },
    ]);
    expect(byCode.get('admin_order_paid')?.channelProblems.map((p) => [p.channel, p.kind])).toEqual(
      [
        ['wechatOa', 'notApplicable'],
        ['sms', 'notApplicable'],
      ],
    );
    expect(byCode.get('order_paid')?.channelProblems).toEqual([]);
  });

  it('refuses a save naming the channel in the way, and the way out', async () => {
    await writeDirectly('order_shipped', {
      inApp: { enabled: true, title: '已发货', body: '订单 {{orderNo}}' },
      wechatMini: { enabled: true, templateKey: '1458' },
    });
    const current = await notificationAdmin.getTemplate(superAdmin(), { code: 'order_shipped' });

    const error = await refusal(
      notificationAdmin.saveTemplate(
        superAdmin(),
        { code: 'order_shipped' },
        {
          channels: {
            ...current.channels,
            inApp: { enabled: true, title: '改了标题', body: '正文' },
          },
          isEnabled: true,
        },
      ),
    );
    expect(error.code).toBe('NOTIFICATION_CHANNEL_INCOMPLETE');
    expect(error.message).toBe(
      '「小程序」已开启但无法发送：缺模板 ID、字段映射。请填写，或关闭该渠道后再保存',
    );
  });

  it('turns one broken switch off although another on the same row is broken too', async () => {
    await writeDirectly('admin_order_paid', {
      inApp: { enabled: true, title: '新订单', body: '订单 {{orderNo}}' },
      sms: { enabled: true, templateCode: '' },
      wechatOa: { enabled: true, templateKey: '' },
    });

    const afterSms = await notificationAdmin.toggleChannel(
      superAdmin(),
      { code: 'admin_order_paid', channel: 'sms' },
      { enabled: false },
    );
    expect(afterSms.channelProblems.map((p) => p.channel)).toEqual(['wechatOa']);

    const error = await refusal(
      notificationAdmin.toggleChannel(
        superAdmin(),
        { code: 'admin_order_paid', channel: 'sms' },
        { enabled: true },
      ),
    );
    expect(error.code).toBe('NOTIFICATION_CHANNEL_NOT_APPLICABLE');
    expect(error.message).toBe('「短信」：该通知不支持此渠道');

    // Turning off what is not there is not an error: the switch is off.
    const again = await notificationAdmin.toggleChannel(
      superAdmin(),
      { code: 'admin_order_paid', channel: 'sms' },
      { enabled: false },
    );
    expect(again.channels.sms).toBeUndefined();

    const afterOa = await notificationAdmin.toggleChannel(
      superAdmin(),
      { code: 'admin_order_paid', channel: 'wechatOa' },
      { enabled: false },
    );
    expect(afterOa.channelProblems).toEqual([]);
  });
});

describe('通知发送记录 says what each channel did, not what the event supports', () => {
  const reader = (): Ctx =>
    harness.as({ kind: 'admin', id: 1, permissions: ['notification:log:read'], isSuper: false });

  async function logFor(scopeId: string, status: 'pending' | 'done' | 'unknown') {
    const { items } = await notificationAdmin.listLogs(reader(), { status, page: 1, pageSize: 20 });
    const log = items.find((item) => `${item.code}:${item.subject}` === scopeId);
    expect(log).toBeDefined();
    return log!;
  }

  it('shows a done row whose SMS had no provider as 未发出, with the reason', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 40 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid');

    await record({ event: 'order_paid', subject: { scope: 'order', id: 41 }, userId });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1 });

    const log = await logFor('order_paid:order:41', 'done');
    expect(log.status).toBe('done');
    expect(log.channels).toEqual([
      { channel: 'inApp', outcome: 'sent', note: null },
      { channel: 'wechatOa', outcome: 'skipped', note: '该渠道没有开启' },
      { channel: 'wechatMini', outcome: 'skipped', note: '该渠道没有开启' },
      { channel: 'sms', outcome: 'skipped', note: '没有配置短信服务商（系统设置 → 短信）' },
    ]);
  });

  it('shows the failed channel while it retries, and every sent one once it lands', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 42 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await enableSms('order_paid');

    registerSmsPort(smsPort(() => ({ ok: false, errorCode: 'isv.BUSINESS_LIMIT_CONTROL' })));
    await record({ event: 'order_paid', subject: { scope: 'order', id: 43 }, userId });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ retried: 1 });

    const retrying = await logFor('order_paid:order:43', 'pending');
    expect(retrying.channels).toContainEqual({ channel: 'inApp', outcome: 'sent', note: null });
    // The provider's own words stay in the ledger (技术详情) and the log; both
    // the channel and 最后错误 say it in Chinese.
    expect(retrying.channels).toContainEqual({
      channel: 'sms',
      outcome: 'failed',
      note: '发送失败：该手机号收到的短信太多，被服务商限流（isv.BUSINESS_LIMIT_CONTROL）',
    });
    expect(retrying.lastErrorSummary).toBe(
      '短信：该手机号收到的短信太多，被服务商限流（isv.BUSINESS_LIMIT_CONTROL）',
    );
    expect(retrying.lastError).toContain('isv.BUSINESS_LIMIT_CONTROL');

    registerSmsPort(smsPort(() => ({ ok: true })));
    harness.clock.advance(60_000);
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1 });

    // The in-app copy went out on the first attempt; the retry skipped it by
    // its claim, and the log still calls it sent.
    const done = await logFor('order_paid:order:43', 'done');
    expect(done.channels.filter((entry) => entry.outcome === 'sent').map((e) => e.channel)).toEqual(
      ['inApp', 'sms'],
    );
    expect(await messagesFor('userId', userId)).toHaveLength(2);
  });

  it('shows an event the operator turned off as 未发出 on every channel', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 44 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    await harness.ctx.db
      .update(notificationTemplates)
      .set({ isEnabled: false })
      .where(eq(notificationTemplates.code, 'order_paid'));

    await record({ event: 'order_paid', subject: { scope: 'order', id: 45 }, userId });
    await dispatchEffectsOnce(harness.ctx);

    const log = await logFor('order_paid:order:45', 'done');
    expect(log.channels).toHaveLength(4);
    for (const entry of log.channels) {
      expect(entry).toMatchObject({ outcome: 'skipped', note: '该通知已停用' });
    }
  });

  it('shows an admin event nobody may receive as 未发出, not 已发送', async () => {
    await record({ event: 'admin_refund_applied', subject: { scope: 'refund', id: 46 } });
    expect(await dispatchEffectsOnce(harness.ctx)).toMatchObject({ done: 1 });

    const log = await logFor('admin_refund_applied:refund:46', 'done');
    expect(log.channels).toEqual([
      { channel: 'inApp', outcome: 'skipped', note: '没有哪个管理员有接收这条通知的权限' },
    ]);
  });

  it('calls a row from before per-channel outcomes 未知 unless its claim still stands', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 47 }, userId });
    await dispatchEffectsOnce(harness.ctx);
    // What a row written by the previous release looks like.
    await harness.ctx.db
      .update(effectsTable)
      .set({ outcome: null })
      .where(eq(effectsTable.scopeId, 'order_paid:order:47'));

    const fresh = await logFor('order_paid:order:47', 'done');
    expect(fresh.channels[0]).toEqual({ channel: 'inApp', outcome: 'sent', note: null });
    expect(fresh.channels.slice(1).map((entry) => entry.outcome)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);

    // Seven days on, the claim has expired: no longer evidence either way.
    await harness.redis.del(`notify:sent:order_paid:order:47:inApp:${userId}`);
    const expired = await logFor('order_paid:order:47', 'done');
    expect(expired.channels.map((entry) => entry.outcome)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('shows a row the dispatcher has not reached yet with no channels', async () => {
    const userId = await makeUser();
    await record({ event: 'order_paid', subject: { scope: 'order', id: 48 }, userId });
    expect((await logFor('order_paid:order:48', 'pending')).channels).toEqual([]);
  });
});
