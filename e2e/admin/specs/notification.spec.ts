import { getEffectHandler } from '@shop/core/effects';
import { withTx } from '@shop/core/kernel';
import {
  notificationKey,
  notify,
  registerNotificationDomain,
  type NotifyInput,
} from '@shop/core/notification';
import { effects } from '@shop/db/schema/system';
import { and, eq } from 'drizzle-orm';
import type { APIRequestContext, Page } from '@playwright/test';

import { test, expect, cjk, dialog, loginCookies, toast, ORIGIN_HEADERS } from '../src/fixtures';
import { BASE_URL } from '../src/stack-file';
import type { Stack } from '../src/stack';

/**
 * 通知 (N1) — a 退款申请 notification, from the effect row to the admin who
 * may act on it, and to nobody else.
 *
 * The suite runs no worker, so the arrangement plays the dispatcher's part in
 * the open: `notify` writes the effect row inside a transaction exactly as the
 * refund domain does, and the registered handler for that row is then run once
 * and the row marked `done` — which is all `dispatchEffectsOnce` does for it.
 * Running the real dispatcher instead would also claim every other due row in
 * this database (the refund spec's execution effect among them) and turn this
 * spec into a side effect of that one.
 *
 * Everything after the arrangement is asserted where an operator would meet
 * it: the inbox API behind the bell, the send log, the template screen, and
 * the SSE stream.
 *
 * The bell is asserted both ways: a pushed notification moves it (the stream
 * names its events, so the hook must listen for the named one), and a
 * notification written while nobody was looking is on it at load (the bell
 * reads the durable inbox).
 */

const EVENT = 'admin_refund_applied';

/** Unique per run, so a reused stack's ledger cannot dedupe this run's rows away. */
let serial = Date.now() % 1_000_000_000;

function refundApplied(title = 'E2E'): NotifyInput {
  serial += 1;
  return {
    event: EVENT,
    subject: { scope: 'refund', id: serial },
    data: {
      refundId: serial,
      refundNo: `RF${serial}`,
      orderNo: 'E2E00000002',
      amount: '99.00',
      reason: title,
    },
  };
}

/** `notify` in a transaction, then the handler once, then `done` — the dispatcher's one pass. */
async function notifyAndDispatch(shop: Stack, input: NotifyInput): Promise<void> {
  registerNotificationDomain();
  await withTx(shop.db, (tx) => notify(tx, shop.ctx, input));
  const [row] = await shop.db
    .select()
    .from(effects)
    .where(and(eq(effects.scope, 'notification'), eq(effects.scopeId, notificationKey(input))));
  expect(row, 'notify wrote no effect row — is the event still registered?').toBeDefined();
  const handler = getEffectHandler(row!.scope, row!.eventType);
  expect(handler, `${row!.scope}/${row!.eventType} has no handler`).toBeDefined();
  await handler!(shop.ctx, {
    id: row!.id,
    scope: row!.scope,
    scopeId: row!.scopeId,
    eventType: row!.eventType,
    payload: row!.payload,
    attempts: row!.attempts + 1,
  });
  await shop.db
    .update(effects)
    .set({
      status: 'done',
      attempts: row!.attempts + 1,
      lastError: null,
      lastErrorSummary: null,
      updatedAt: new Date(),
    })
    .where(eq(effects.id, row!.id));
}

interface InboxItem {
  id: string;
  code: string;
  title: string;
  content: string;
  readAt: string | null;
}

async function inbox(api: APIRequestContext): Promise<InboxItem[]> {
  const response = await api.get('/admin-api/notifications?page=1&pageSize=50');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: InboxItem[] }).items;
}

async function unread(api: APIRequestContext): Promise<number> {
  const response = await api.get('/admin-api/notifications/unread-count');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { unread: number }).unread;
}

/** A browser-side `EventSource` on the bell's URL, recording both kinds of event it could see. */
async function openProbe(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const seen = { named: [] as string[], unnamed: [] as string[] };
        (window as unknown as { __probe: typeof seen }).__probe = seen;
        const source = new EventSource('/admin-api/notifications/stream', {
          withCredentials: true,
        });
        source.addEventListener('notification', (event) =>
          seen.named.push((event as MessageEvent<string>).data),
        );
        source.onmessage = (event: MessageEvent<string>) => seen.unnamed.push(event.data);
        source.onopen = () => resolve();
        source.onerror = () => reject(new Error('the notification stream did not open'));
      }),
  );
}

test('a 退款申请 reaches the inbox of an admin who can handle refunds, once', async ({
  adminApi,
  shop,
}) => {
  const before = await unread(adminApi);
  const input = refundApplied();
  await notifyAndDispatch(shop, input);

  const mine = (await inbox(adminApi)).filter((item) => item.code === EVENT);
  const message = mine.find((item) => item.content.includes(`RF${input.subject.id}`));
  expect(message, 'the super admin holds refund:request:read implicitly').toBeDefined();
  expect(message!.title).toBe('新的退款申请');
  expect(message!.content).toBe(`退款单 RF${input.subject.id} 待处理，金额 ¥99.00。`);
  expect(message!.readAt).toBeNull();
  expect(await unread(adminApi)).toBe(before + 1);

  // The ledger's key makes asking twice free: the second `notify` for the same
  // aggregate writes nothing, and the inbox does not grow.
  await withTx(shop.db, (tx) => notify(tx, shop.ctx, input));
  expect(await unread(adminApi)).toBe(before + 1);

  // Reading is an explicit act, and it is counted.
  const read = await adminApi.post(`/admin-api/notifications/${message!.id}/read`, { data: {} });
  expect(read.status()).toBe(200);
  expect(await read.json()).toEqual({ marked: 1 });
  expect(await unread(adminApi)).toBe(before);
});

test('an admin without refund:request:read is told nothing and cannot touch the message', async ({
  adminApi,
  playwright,
  shop,
}) => {
  // A narrow role, through the same API the role screen uses (the screen
  // itself is `restricted-role.spec.ts`'s subject).
  const role = await adminApi.post('/admin-api/roles', {
    data: {
      name: `E2E 仓库 ${serial}`,
      enabled: true,
      permissions: ['order:order:read'],
    },
  });
  expect(role.status(), await role.text()).toBe(201);
  const roleId = ((await role.json()) as { id: string }).id;
  const account = `e2e-warehouse-${serial}`;
  const password = 'e2e-Warehouse0!';
  const admin = await adminApi.post('/admin-api/admins', {
    data: { account, name: '仓库', password, roleIds: [roleId], enabled: true },
  });
  expect(admin.status(), await admin.text()).toBe(201);

  const narrow = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: ORIGIN_HEADERS,
  });
  await loginCookies(narrow, account, password);
  const narrowBefore = await unread(narrow);

  const input = refundApplied();
  await notifyAndDispatch(shop, input);

  // The super admin has it …
  const theirs = (await inbox(adminApi)).find((item) =>
    item.content.includes(`RF${input.subject.id}`),
  );
  expect(theirs).toBeDefined();

  // … the warehouse account does not, not even as a count.
  expect(await unread(narrow)).toBe(narrowBefore);
  expect((await inbox(narrow)).some((item) => item.content.includes(`RF${input.subject.id}`))).toBe(
    false,
  );

  // And another admin's message id is indistinguishable from one that does not exist.
  const poke = await narrow.post(`/admin-api/notifications/${theirs!.id}/read`, { data: {} });
  expect(poke.status()).toBe(404);
  expect(((await poke.json()) as { code: string }).code).toBe('NOTIFICATION_MESSAGE_NOT_FOUND');
  // The owner's copy is untouched by the attempt.
  const still = (await inbox(adminApi)).find((item) => item.id === theirs!.id);
  expect(still!.readAt).toBeNull();

  await narrow.dispose();
});

test('the send log shows the send, and the template screen decides the wording', async ({
  adminPage,
  adminApi,
  shop,
}) => {
  const input = refundApplied();
  await notifyAndDispatch(shop, input);

  // 发送记录 defaults to 需要处理; a finished send is under 已完成, and 渠道
  // says the in-app copy is what went out.
  await adminPage.goto(`/admin/notification/logs?status=done&code=${EVENT}`);
  const row = adminPage.getByRole('row').filter({ hasText: `refund:${input.subject.id}` });
  await expect(row).toBeVisible();
  await expect(row.getByText('已完成')).toBeVisible();
  await expect(row.getByText('站内信 已发送')).toBeVisible();

  // Now change the in-app title on 通知模板, the way an operator would.
  const code = `/admin-api/notification-templates/${EVENT}`;
  const original = (await (await adminApi.get(code)).json()) as {
    channels: unknown;
    isEnabled: boolean;
  };
  try {
    await adminPage.goto(`/admin/notification/templates?keyword=${EVENT}`);
    const templateRow = adminPage.getByRole('row').filter({ hasText: EVENT });
    await templateRow.getByText('配置').click();
    const modal = dialog(adminPage);
    await expect(modal.getByText('配置：用户申请退款提醒')).toBeVisible();
    await modal.getByLabel('站内信标题').fill('退款待处理（E2E）');
    await modal.getByRole('button', { name: cjk('保存') }).click();
    await expect(toast(adminPage, '已保存')).toBeVisible();
    await expect(modal).toBeHidden();

    const next = refundApplied();
    await notifyAndDispatch(shop, next);
    const message = (await inbox(adminApi)).find((item) =>
      item.content.includes(`RF${next.subject.id}`),
    );
    expect(message?.title).toBe('退款待处理（E2E）');
  } finally {
    // Put the registry's wording back, so a reused stack starts where a fresh one does.
    const restored = await adminApi.put(code, {
      data: { channels: original.channels, isEnabled: original.isEnabled },
    });
    expect(restored.status(), await restored.text()).toBe(200);
  }
});

test('the stream refuses a caller with no session, and pushes to one with a session', async ({
  adminPage,
  playwright,
  shop,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: BASE_URL });
  const refused = await anonymous.get('/admin-api/notifications/stream');
  expect(refused.status()).toBe(401);
  await anonymous.dispose();

  // Server side, the push works: the super admin's own EventSource receives it
  // as a *named* `notification` event, with the payload the bell's schema
  // expects. It never arrives as an unnamed message — which is the half the
  // bell listens to (next test).
  await openProbe(adminPage);
  const input = refundApplied();
  await notifyAndDispatch(shop, input);
  await adminPage.waitForFunction(
    () => (window as unknown as { __probe: { named: string[] } }).__probe.named.length > 0,
  );
  const seen = await adminPage.evaluate(
    () => (window as unknown as { __probe: { named: string[]; unnamed: string[] } }).__probe,
  );
  const pushed = JSON.parse(seen.named[0]!) as Record<string, unknown>;
  expect(pushed).toMatchObject({ type: EVENT, title: '新的退款申请' });
  expect(typeof pushed['id']).toBe('string');
  expect(typeof pushed['createdAt']).toBe('string');
  expect(seen.unnamed).toEqual([]);
});

/** What antd's badge renders for a count. */
const badge = (count: number): string => (count > 99 ? '99+' : String(count));

test('the bell shows a pushed notification', async ({ adminPage, adminApi, shop }) => {
  // The route sends `event: notification`, and the hook listens for that named
  // event; `onmessage` alone would never fire.
  const before = await unread(adminApi);

  // Reload so the bell's own EventSource is opened while we are watching for it.
  await Promise.all([
    adminPage.waitForResponse((response) =>
      response.url().endsWith('/admin-api/notifications/stream'),
    ),
    adminPage.reload(),
  ]);
  const bell = adminPage.getByTestId('notification-bell');
  await expect(bell).toBeVisible();
  // The bell starts from the inbox; wait for it so the push is what moves it.
  if (before > 0) await expect(bell.locator('.ant-badge-count')).toHaveText(badge(before));
  await notifyAndDispatch(shop, refundApplied());
  await expect(bell.locator('.ant-badge-count')).toHaveText(badge(before + 1), { timeout: 5_000 });
});

test('the bell shows the unread inbox on load', async ({ adminPage, adminApi, shop }) => {
  // The bell reads `/admin-api/notifications?unreadOnly` and
  // `/unread-count` on load, so a notification written while nobody was
  // looking is on the badge when the operator arrives.
  await notifyAndDispatch(shop, refundApplied());
  const count = await unread(adminApi);
  expect(count).toBeGreaterThan(0);
  await adminPage.reload();
  const bell = adminPage.getByTestId('notification-bell');
  await expect(bell.locator('.ant-badge-count')).toHaveText(badge(count), { timeout: 5_000 });

  // And 全部已读 is a server write: the next load starts at zero.
  await bell.click();
  await adminPage.getByRole('button', { name: cjk('全部已读') }).click();
  await expect.poll(() => unread(adminApi)).toBe(0);
  await adminPage.reload();
  await expect(adminPage.getByTestId('notification-bell')).toBeVisible();
  await expect(adminPage.getByTestId('notification-bell').locator('.ant-badge-count')).toHaveCount(
    0,
  );
});
