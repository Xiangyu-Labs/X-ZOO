import type { Page } from '@playwright/test';

import { test, expect, cjk, dialog, toast } from '../src/fixtures';

/**
 * 发货 → 确认收货, on a real paid order.
 *
 * `order.fulfil.concurrency.int.test.ts` proves shipping cannot outrun a
 * refund. What is only visible from here is that the shipping *form* refuses
 * to send an express parcel without a courier and a tracking number — the
 * refine that enforces it attaches its message to `发货方式`, two fields away
 * from where the operator is looking, which is exactly the sort of thing that
 * ships broken.
 */

/**
 * 发货 by 顺丰 with a typed tracking number, on the order page already open.
 *
 * The modal closing is the assertion, not the toast: antd's message is torn
 * down when the page refetches, and a three-second banner is not what the
 * warehouse depends on.
 */
async function shipThroughScreen(page: Page): Promise<void> {
  await page.getByRole('button', { name: cjk('发货') }).click();
  const modal = dialog(page);
  await modal.getByLabel('物流公司').click();
  await page.getByTitle('顺丰速运', { exact: true }).click();
  await modal.getByLabel('运单号').fill('SF1234567890');
  await modal.getByRole('button', { name: cjk('保存') }).click();
  await expect(modal).toBeHidden();
}

test('an express shipment needs a courier and a tracking number', async ({ adminPage, shop }) => {
  await adminPage.goto(`/admin/orders/${shop.fixtures.shippableOrderId}`);
  await expect(adminPage.getByRole('heading', { name: /订单 E2E00000001/ })).toBeVisible();

  await adminPage.getByRole('button', { name: cjk('发货') }).click();
  const modal = dialog(adminPage);
  await expect(modal).toBeVisible();

  // Save with nothing filled in: the refine must stop it, and must say so.
  await modal.getByRole('button', { name: cjk('保存') }).click();
  await expect(modal).toBeVisible();
  await expect(modal.getByText('快递发货需要物流公司和运单号')).toBeVisible();
});

// Every `dedupeKey` is `name:id`, and BullMQ 6 refuses a custom job id with one
// colon in it, so a shipment would commit and then answer 500 from the enqueue
// that follows it. `queue-bullmq.ts` maps the port's opaque key onto a BullMQ id
// (`toJobId`); this journey proves that holds at the HTTP boundary, on a real
// Redis, which no unit or integration suite reaches (they all run on
// `memoryQueue()`).
test('ship it, then confirm receipt', async ({ adminPage, adminApi, shop }) => {
  const orderId = shop.fixtures.shippableOrderId;
  await adminPage.goto(`/admin/orders/${orderId}`);

  await shipThroughScreen(adminPage);

  // The shipment is on the page, with the number that was typed — twice: the
  // shipment card and the timeline entry.
  await expect(adminPage.getByText('SF1234567890').first()).toBeVisible();

  // 确认收货 only appears once the order is shipped — it is in the page
  // header, not in the shipping card, and it is a Popconfirm.
  const confirm = adminPage.getByRole('button', { name: '确认收货' });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await adminPage.getByRole('button', { name: cjk('确定') }).click();
  await expect(toast(adminPage, '已确认收货')).toBeVisible();

  // And the order really moved, not just the screen.
  const detail = await adminApi.get(`/admin-api/orders/${orderId}`);
  expect(detail.status()).toBe(200);
  const body = await detail.json();
  expect(['received', 'completed']).toContain(body.status);
  expect(body.fulfillmentStatus).toBe('fulfilled');

  // Shipping is an admin write, so it left an audit row naming the order.
  const audit = await adminApi.get('/admin-api/audit-logs?page=1&pageSize=20');
  expect(audit.status()).toBe(200);
  const targets = ((await audit.json()).items as Array<{ target: string | null }>).map(
    (row) => row.target,
  );
  expect(targets.some((target) => target?.includes(String(orderId)))).toBe(true);
});

test('an order that is already shipped cannot be shipped again', async ({
  adminPage,
  adminApi,
  shop,
}) => {
  const orderId = shop.fixtures.shippableOrderId!;
  // The journey above ships this order through the screen. When this test runs
  // on its own it ships it the same way — through the 发货 dialog, never a
  // service call — so the precondition is itself the screen's doing.
  await adminPage.goto(`/admin/orders/${orderId}`);
  const before = await (await adminApi.get(`/admin-api/orders/${orderId}`)).json();
  if (before.fulfillmentStatus !== 'fulfilled') await shipThroughScreen(adminPage);

  await adminPage.reload();
  // Every line is now on its way; the button is gone, because there is nothing
  // left to send.
  // Twice on the page: the shipment card and the timeline entry.
  await expect(adminPage.getByText('SF1234567890').first()).toBeVisible();
  await expect(adminPage.getByRole('button', { name: cjk('发货') })).toHaveCount(0);
});
