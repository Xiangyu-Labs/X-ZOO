import { configValues } from '@shop/db/schema/system';
import { and, eq } from 'drizzle-orm';

import { test, expect, cjk, toast } from '../src/fixtures';

/**
 * A credential goes in and does not come back out.
 *
 * `system.int.test.ts` asserts this at the service boundary and `pnpm guards`'
 * `secrets` check asserts it across every response schema in the repository.
 * What neither can assert is the screen: that the operator can tell a stored
 * credential from a missing one without being shown it, and that saving the
 * rest of the form does not quietly blank the credential — which is how a
 * shop loses its SMS gateway on a Tuesday afternoon.
 *
 * The `sms` group is used rather than `payment` on purpose: it has a secret
 * behind a `visibleWhen`, so the spec also covers the conditional field, and
 * nothing in this suite ever sends an SMS.
 */

const SECRET = 'e2e-access-key-secret-0123456789';

test('a secret is stored, shown as 已设置, and never sent back', async ({
  adminPage,
  adminApi,
  shop,
}) => {
  await adminPage.goto('/admin/system/settings/sms');
  await expect(adminPage.getByRole('heading', { name: '短信设置' })).toBeVisible();

  // Nothing is configured yet.
  await expect(adminPage.getByTestId('secret-state-aliyunAccessKeySecret')).toHaveCount(0);

  // The Aliyun credentials only exist while Aliyun is the selected provider.
  // The dropdown entry is addressed by its option class rather than by
  // `getByTitle`, which also matches the closed select's own label once a value
  // is selected, or by `getByRole('option')`, which resolves to rc-select's
  // visually hidden accessibility list (`<div role="option">aliyun</div>`)
  // instead of the item a mouse can hit.
  await adminPage.getByLabel('短信服务商').click();
  await adminPage.locator('.ant-select-item-option[title="阿里云"]').click();

  const state = adminPage.getByTestId('secret-state-aliyunAccessKeySecret');
  const input = adminPage.getByTestId('secret-input-aliyunAccessKeySecret');
  await expect(state).toHaveText('未设置');
  await expect(input).toHaveValue('');

  await adminPage.getByLabel('AccessKeyId', { exact: true }).fill('e2e-access-key-id');
  await input.fill(SECRET);
  await adminPage.getByRole('button', { name: cjk('保存') }).click();
  await expect(toast(adminPage, '已保存')).toBeVisible();

  // The screen now says a value exists, shows the "leave blank" placeholder,
  // and holds nothing.
  await adminPage.reload();
  await expect(state).toHaveText('已设置');
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('placeholder', '已设置，留空则不修改');

  // The response the browser was given carries a boolean, not the secret.
  const read = await adminApi.get('/admin-api/system/config/sms');
  expect(read.status()).toBe(200);
  const body = await read.json();
  expect(body.values.aliyunAccessKeySecret).toBe(true);
  expect(JSON.stringify(body), 'the secret must not appear anywhere in the payload').not.toContain(
    SECRET,
  );

  // And it really was stored — otherwise "never sent back" would be trivially
  // true and the gateway would simply be broken.
  const stored = await shop.db
    .select({ value: configValues.value })
    .from(configValues)
    .where(and(eq(configValues.group, 'sms'), eq(configValues.key, 'aliyunAccessKeySecret')));
  // drizzle's jsonb column parses the row, so this is already the string.
  expect(stored[0]!.value).toBe(SECRET);
});

test('saving the form again does not blank the credential', async ({ adminPage, shop }) => {
  await adminPage.goto('/admin/system/settings/sms');
  await adminPage.getByLabel('短信服务商').click();
  await adminPage.locator('.ant-select-item-option[title="阿里云"]').click();
  await expect(adminPage.getByTestId('secret-state-aliyunAccessKeySecret')).toHaveText('已设置');

  // Change a neighbour and save without retyping the secret — the thing an
  // operator does every time they fix a typo in the signature.
  await adminPage.getByLabel('短信签名', { exact: true }).first().fill('E2E 商城');
  await adminPage.getByRole('button', { name: cjk('保存') }).click();
  await expect(toast(adminPage, '已保存')).toBeVisible();

  const stored = await shop.db
    .select({ value: configValues.value })
    .from(configValues)
    .where(and(eq(configValues.group, 'sms'), eq(configValues.key, 'aliyunAccessKeySecret')));
  // drizzle's jsonb column parses the row, so this is already the string.
  expect(stored[0]!.value).toBe(SECRET);
});

test('the settings index hides the groups this admin may not read', async ({ adminPage }) => {
  await adminPage.goto('/admin/system/settings');
  // The super admin sees them; the assertion that a *narrow* role does not is
  // in `restricted-role.spec.ts`, where the 403 is the evidence.
  await expect(adminPage.getByRole('link', { name: /短信设置/ })).toBeVisible();
});
