import { test, expect, cjk, dialog, toast } from '../src/fixtures';

/**
 * A coupon template, and one grant of it.
 *
 * The grant is the interesting half: it is the screen that hands out money,
 * it takes a free-text list of user ids, and the shop's stock is decremented
 * by it. A spec that only created the template would be testing a form.
 */

const NAME = `E2E 满减券 ${Date.now()}`;

test('create a coupon template and grant it to a buyer', async ({ adminPage, shop }) => {
  await adminPage.goto('/admin/coupon/templates');
  await adminPage.getByRole('button', { name: '新建优惠券' }).click();

  const modal = dialog(adminPage);
  await expect(modal.getByText('新建优惠券')).toBeVisible();
  await modal.getByLabel('名称').fill(NAME);
  await modal.getByLabel('面额').fill('10.00');

  // 进行中, or the storefront and the grant would both refuse it.
  await modal.getByLabel('状态', { exact: true }).click();
  await adminPage.getByTitle('进行中', { exact: true }).click();

  await modal.getByLabel('适用范围').click();
  await adminPage.getByTitle('全场通用', { exact: true }).click();

  await modal.getByLabel('发放方式').click();
  await adminPage.getByTitle('后台发放', { exact: true }).click();

  await modal.getByLabel('有效期方式').click();
  await adminPage.getByTitle('领取后生效', { exact: true }).click();
  await modal.getByLabel('领取后有效天数').fill('7');

  await modal.getByLabel('发放总量').fill('100');

  await modal.getByRole('button', { name: cjk('保存') }).click();
  await expect(modal).toBeHidden();
  await expect(adminPage.getByRole('cell', { name: NAME })).toBeVisible();

  // ---- 发放 ----
  const row = adminPage.getByRole('row').filter({ hasText: NAME });
  await row.getByRole('button', { name: cjk('发放') }).click();

  const grant = dialog(adminPage);
  await expect(grant.getByText('粘贴用户 ID')).toBeVisible();
  await grant.getByPlaceholder('1001 1002 1003').fill(String(shop.fixtures.userId));
  await grant.getByRole('button', { name: cjk('发放') }).click();
  await expect(toast(adminPage, '已发放 1 张')).toBeVisible();

  // ---- and it is on the buyer's record ----
  await adminPage.goto(`/admin/coupon/user-coupons?userId=${shop.fixtures.userId}`);
  await expect(adminPage.getByRole('cell', { name: NAME })).toBeVisible();
  await expect(adminPage.getByRole('cell', { name: '后台发放' })).toBeVisible();
});

test('a grant of nothing is refused before it reaches the server', async ({ adminPage }) => {
  await adminPage.goto('/admin/coupon/templates');
  const row = adminPage.getByRole('row').filter({ hasText: NAME });
  await row.getByRole('button', { name: cjk('发放') }).click();

  const grant = dialog(adminPage);
  await grant.getByRole('button', { name: cjk('发放') }).click();
  await expect(grant.getByText('请填写用户 ID')).toBeVisible();
  await expect(grant).toBeVisible();
});

test('作废 a grant, then grant again to everyone the 客户列表 filter matches', async ({
  adminPage,
  shop,
}) => {
  // ---- 作废 the coupon the first spec handed out ----
  await adminPage.goto(`/admin/coupon/user-coupons?userId=${shop.fixtures.userId}`);
  const granted = adminPage.getByRole('row').filter({ hasText: NAME });
  await granted.getByRole('button', { name: cjk('作废') }).click();
  const popup = adminPage.locator('.ant-popover').filter({ hasText: `作废「${NAME}」？` });
  await popup.getByRole('button', { name: cjk('作废') }).click();
  await expect(toast(adminPage, '已作废')).toBeVisible();
  await expect(granted.getByRole('cell', { name: '已作废' })).toBeVisible();

  // ---- 给筛选结果发券: the revoked coupon gave the buyer's place back ----
  await adminPage.goto('/admin/user/customers?keyword=e2e-customer');
  await adminPage.getByRole('button', { name: '给筛选结果发券（1 人）' }).click();
  const grant = dialog(adminPage);
  await grant.getByRole('combobox', { name: '优惠券' }).fill(NAME);
  await adminPage.getByTitle(NAME, { exact: true }).click();
  await grant.getByRole('button', { name: cjk('发放') }).click();
  await expect(toast(adminPage, '已发放 1 张')).toBeVisible();

  await adminPage.goto(`/admin/coupon/user-coupons?userId=${shop.fixtures.userId}`);
  const rows = adminPage.getByRole('row').filter({ hasText: NAME });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '未使用' })).toHaveCount(1);
});
