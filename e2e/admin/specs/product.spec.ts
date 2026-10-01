import { test, expect, cjk, toast } from '../src/fixtures';
import { PNG } from '../src/files';

/**
 * A product created in the admin, then read from the storefront.
 *
 * The chain is the assertion: the form's shape, the asset picker, the write
 * path, and the public read all have to agree, and each of them lives in a
 * different layer. An integration test can prove any one of them; only this
 * can prove they share the same idea of a product.
 */

const NAME = `E2E 全流程商品 ${Date.now()}`;

test('create a product in the admin and the storefront API returns it', async ({
  adminPage,
  request,
}) => {
  await adminPage.goto('/admin/catalog/products/new');
  await expect(adminPage.getByRole('heading', { name: '新建商品' })).toBeVisible();

  await adminPage.getByLabel('商品名称').fill(NAME);

  // 状态 defaults to 草稿; a draft is deliberately invisible on the storefront,
  // so a spec that forgot this would "pass" by asserting nothing.
  await adminPage.getByLabel('状态', { exact: true }).click();
  await adminPage.getByTitle('出售中', { exact: true }).click();

  // 商品主图 is required and has no text input — it is an AssetField, which
  // opens the picker. Upload into the picker, so this spec does not depend on
  // the library already containing anything.
  await adminPage.getByTestId('asset-field-add').first().click();
  const picker = adminPage.getByRole('dialog').filter({ hasText: '选择素材' });
  await expect(picker).toBeVisible();
  await picker.locator('.ant-upload input[type="file"]').setInputFiles(PNG);
  await expect(picker.locator('[data-testid^="asset-"]').first()).toBeVisible();
  await picker.locator('[data-testid^="asset-"]').first().click();
  await picker.getByRole('button', { name: /确定（1）/ }).click();
  await expect(picker).toBeHidden();

  // 商品分类 — the seed made one, because a TreeSelect cannot invent one.
  await adminPage.getByLabel('商品分类').click();
  await adminPage.getByTitle('E2E 类目', { exact: true }).click();
  await adminPage.keyboard.press('Escape');

  // The default freight mode is 运费模板, which then *requires* a template id.
  // 包邮 is the only mode a fresh shop can satisfy.
  // The radio itself is antd's zero-sized visually-hidden input, which
  // `check()` refuses to act on; the label beside it is what an operator
  // clicks and what actually toggles the group.
  await adminPage.getByText('包邮', { exact: true }).click();

  // The single-SKU card. Its controls are captions with aria-labels, not
  // Form.Item labels.
  await adminPage.getByLabel('库存', { exact: true }).first().fill('7');

  await adminPage.getByRole('button', { name: cjk('保存') }).click();
  await expect(toast(adminPage, '已创建')).toBeVisible();

  // The editor replaces the URL with the new id — which is how the spec
  // learns it without reaching into the database.
  await expect(adminPage).toHaveURL(/\/admin\/catalog\/products\/\d+$/);
  const productId = adminPage.url().split('/').pop()!;

  // ---- and now the storefront, with no session at all ----
  const detail = await request.get(`/api/v1/catalog/products/${productId}`);
  expect(detail.status(), await detail.text()).toBe(200);
  const body = await detail.json();
  expect(body.name).toBe(NAME);
  expect(body.id).toBe(productId);

  const search = await request.get(
    `/api/v1/catalog/products?page=1&pageSize=20&keyword=${encodeURIComponent('E2E 全流程商品')}`,
  );
  expect(search.status()).toBe(200);
  const names = ((await search.json()).items as Array<{ name: string }>).map((i) => i.name);
  expect(names).toContain(NAME);
});

test('a draft product is not on the storefront', async ({ adminPage, request }) => {
  const draftName = `E2E 草稿商品 ${Date.now()}`;

  await adminPage.goto('/admin/catalog/products/new');
  await adminPage.getByLabel('商品名称').fill(draftName);
  await adminPage.getByTestId('asset-field-add').first().click();
  const picker = adminPage.getByRole('dialog').filter({ hasText: '选择素材' });
  await picker.locator('.ant-upload input[type="file"]').setInputFiles(PNG);
  await picker.locator('[data-testid^="asset-"]').first().click();
  await picker.getByRole('button', { name: /确定（1）/ }).click();
  await adminPage.getByLabel('商品分类').click();
  await adminPage.getByTitle('E2E 类目', { exact: true }).click();
  await adminPage.keyboard.press('Escape');
  // The radio itself is antd's zero-sized visually-hidden input, which
  // `check()` refuses to act on; the label beside it is what an operator
  // clicks and what actually toggles the group.
  await adminPage.getByText('包邮', { exact: true }).click();
  await adminPage.getByRole('button', { name: cjk('保存') }).click();

  await expect(adminPage).toHaveURL(/\/admin\/catalog\/products\/\d+$/);
  const productId = adminPage.url().split('/').pop()!;

  const detail = await request.get(`/api/v1/catalog/products/${productId}`);
  expect(detail.status(), 'a draft must not be readable by a shopper').toBe(404);
});
