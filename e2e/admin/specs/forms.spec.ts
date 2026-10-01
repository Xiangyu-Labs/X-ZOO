import { test, expect, cjk, dialog, toast } from '../src/fixtures';

/**
 * What every form in the admin does the same way, checked once in a real
 * browser: the parts a component test cannot reach because they are the
 * browser's own behaviour (Enter submitting through a button outside the
 * `<form>`) or the router's (a side-menu link).
 */

test('Enter in a one-line field saves the dialog', async ({ adminPage }) => {
  await adminPage.goto('/admin/user/groups');
  await adminPage.getByRole('button', { name: '新建分组' }).click();

  const modal = dialog(adminPage);
  await modal.getByLabel('名称').fill('回车保存的分组');
  await modal.getByLabel('名称').press('Enter');

  await expect(toast(adminPage, '已保存')).toBeVisible();
  await expect(modal).toBeHidden();
  await expect(adminPage.getByRole('cell', { name: '回车保存的分组' })).toBeVisible();
});

test('closing a dialog with typed work asks first', async ({ adminPage }) => {
  await adminPage.goto('/admin/user/groups');
  await adminPage.getByRole('button', { name: '新建分组' }).click();

  const modal = dialog(adminPage).filter({ hasText: '新建分组' });
  await modal.getByLabel('名称').fill('还没保存');
  await adminPage.keyboard.press('Escape');

  const prompt = dialog(adminPage).filter({ hasText: '放弃未保存的修改？' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '继续编辑' }).click();
  await expect(modal.getByLabel('名称')).toHaveValue('还没保存');

  await modal.getByRole('button', { name: cjk('取消') }).click();
  await dialog(adminPage)
    .filter({ hasText: '放弃未保存的修改？' })
    .getByRole('button', { name: '放弃修改' })
    .click();
  await expect(modal).toBeHidden();
});

test('a side-menu link away from an unsaved product asks first', async ({ adminPage }) => {
  await adminPage.goto('/admin/catalog/products/new');
  await adminPage.getByLabel('商品名称').fill('写了一半的商品');
  await expect(adminPage.getByText('有未保存的修改')).toBeVisible();

  await adminPage.getByRole('link', { name: '工作台' }).click();

  const prompt = dialog(adminPage).filter({ hasText: '有未保存的修改' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '继续编辑' }).click();
  await expect(adminPage).toHaveURL(/\/admin\/catalog\/products\/new/);
  await expect(adminPage.getByLabel('商品名称')).toHaveValue('写了一半的商品');
});
