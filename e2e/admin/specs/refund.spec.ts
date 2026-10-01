import { effects } from '@shop/db/schema/system';
import { and, eq } from 'drizzle-orm';

import { test, expect, cjk, dialog, toast } from '../src/fixtures';

/**
 * 审核 — the screen where a person decides whether money goes back.
 *
 * Two things only this level can show. First, that the reviewer is never
 * offered an amount field: the sum was frozen when the buyer applied, and a
 * console that let an operator type a different number would undo four layers
 * of database constraint. Second, that a rejection cannot be filed without a
 * reason the buyer will read.
 *
 * What happens *after* 同意 — the gateway call — needs a worker and a fake
 * WeChat, which this suite deliberately does not run. The assertion therefore
 * stops at the state change and the effect that was queued, which is the last
 * thing the admin surface is responsible for.
 */

test('the reviewer is never shown an amount to change', async ({ adminPage }) => {
  await adminPage.goto('/admin/trade/refunds');
  const row = adminPage.getByRole('row').filter({ hasText: 'E2E00000002' });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: cjk('同意') }).click();
  const modal = dialog(adminPage);
  await expect(modal.getByText('同意退款')).toBeVisible();
  // One field, and it is a note.
  await expect(modal.getByLabel('备注')).toBeVisible();
  await expect(modal.getByLabel('金额')).toHaveCount(0);
  await expect(modal.getByLabel('退款金额')).toHaveCount(0);
  await modal.getByRole('button', { name: cjk('取消') }).click();
});

test('a rejection without a reason is refused', async ({ adminPage }) => {
  await adminPage.goto('/admin/trade/refunds');
  const row = adminPage.getByRole('row').filter({ hasText: 'E2E00000002' });

  await row.getByRole('button', { name: cjk('拒绝') }).click();
  const modal = dialog(adminPage);
  await modal.getByRole('button', { name: '确认拒绝' }).click();
  // Still open: the buyer is going to read this sentence, so there has to be one.
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('拒绝原因')).toBeVisible();
  await modal.getByRole('button', { name: cjk('取消') }).click();
});

test('approving moves the request out of 待处理 and queues exactly one effect', async ({
  adminPage,
  adminApi,
  shop,
}) => {
  const refundId = shop.fixtures.refundId;

  await adminPage.goto('/admin/trade/refunds');
  const row = adminPage.getByRole('row').filter({ hasText: 'E2E00000002' });
  await row.getByRole('button', { name: cjk('同意') }).click();

  const modal = dialog(adminPage);
  await modal.getByLabel('备注').fill('e2e：同意');
  await modal.getByRole('button', { name: '确认同意' }).click();
  await expect(toast(adminPage, '已同意')).toBeVisible();

  const detail = await adminApi.get(`/admin-api/refunds/${refundId}`);
  expect(detail.status()).toBe(200);
  const body = await detail.json();
  expect(body.status, 'the request must not still be waiting for a decision').not.toBe('applied');

  // One effect, however many times the button is pressed. `effects` is keyed
  // `UNIQUE (scope, scope_id, event_type)`, which is the whole exactly-once
  // story, so a second approval cannot add another row.
  const queued = await shop.db
    .select({ eventType: effects.eventType, status: effects.status })
    .from(effects)
    .where(and(eq(effects.scope, 'refund'), eq(effects.scopeId, String(refundId))));
  expect(queued.length).toBe(1);

  // And the decision is no longer offered.
  await adminPage.reload();
  await expect(row.getByRole('button', { name: cjk('同意') })).toHaveCount(0);
});
