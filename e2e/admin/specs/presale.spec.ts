import type { APIRequestContext, Page } from '@playwright/test';
import {
  adminProductForm,
  type AdminProductDetail,
  type StorefrontProduct,
} from '@shop/contracts/catalog/schemas';
import { test, expect, cjk, dialog, toast } from '../src/fixtures';

/** One product editor owns both campaigns; the storefront reads the same saved settings. */
function shanghai(offsetMs: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + offsetMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
async function createProduct(
  api: APIRequestContext,
  sourceId: number,
  name: string,
): Promise<AdminProductDetail> {
  const source = await api.get(`/admin-api/catalog/products/${sourceId}`);
  expect(source.status()).toBe(200);
  const seed = (await source.json()) as AdminProductDetail;
  const response = await api.post('/admin-api/catalog/products', {
    data: adminProductForm.parse({
      name,
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: seed.imageUrl,
      categoryIds: seed.categoryIds,
      freightMode: 'free',
      skus: [{ specValues: {}, price: '99.00', stock: 20 }],
    }),
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as AdminProductDetail;
}
async function storefront(api: APIRequestContext, id: string): Promise<StorefrontProduct> {
  const response = await api.get(`/api/v1/catalog/products/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as StorefrontProduct;
}
async function pickEnd(page: Page, label: string): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(shanghai(7 * 86400_000));
  await input.press('Enter');
}
async function advanced(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: cjk('高级设置') });
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
}
async function save(page: Page, confirm = false): Promise<void> {
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/admin-api/catalog/products/'),
  );
  await page.getByRole('button', { name: cjk('保存') }).click();
  if (confirm) await dialog(page).getByRole('button', { name: '确认保存' }).click();
  const response = await saving;
  expect(response.status(), await response.text()).toBe(200);
  await expect(toast(page, '已保存').last()).toBeVisible();
}

test('product editing saves presale prices, preserves them on edit and switches exclusively to groupbuy', async ({
  adminPage: page,
  adminApi,
  request,
  shop,
}, testInfo) => {
  const title = `E2E 商品活动 ${Date.now()}`;
  const product = await createProduct(adminApi, shop.fixtures.productId!, title);
  await page.goto(`/admin/catalog/products/${product.id}`);
  await page.getByRole('switch', { name: '是否为预售商品' }).click();
  await expect(page.getByRole('switch', { name: '是否为拼单商品' })).not.toBeChecked();
  await pickEnd(page, '预售结束时间');
  await page.getByLabel('付款后发货天数', { exact: true }).fill('7');
  await page.getByLabel('默认规格预售价', { exact: true }).fill('59.00');
  await advanced(page);
  await page.getByLabel('活动标题', { exact: true }).fill(title);
  await page.getByLabel('活动库存', { exact: true }).fill('10');
  await page.getByLabel('默认规格活动库存', { exact: true }).fill('10');
  await save(page);
  const presale = await storefront(request, product.id);
  expect(presale.promotion).toMatchObject({
    kind: 'presale',
    price: '59.00',
    shipAfterDays: 7,
    canBuy: true,
  });
  expect(presale.promotion!.skus).toEqual([
    expect.objectContaining({ skuId: product.skus[0]!.id, price: '59.00', stock: 10 }),
  ]);
  const presaleId = presale.promotion!.activityId;
  const settingsCard = page
    .locator('.ant-card')
    .filter({ has: page.getByText('预售与拼单', { exact: true }) });
  await settingsCard.screenshot({ path: testInfo.outputPath('presale-settings.png') });

  await page.goto(`/admin/presale/activities?keyword=${encodeURIComponent(title)}`);
  const edit = page
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('link', { name: '编辑', exact: true });
  await expect(edit).toHaveAttribute('href', `/admin/catalog/products/${product.id}`);
  await edit.click();
  await expect(page.getByLabel('默认规格预售价', { exact: true })).toHaveValue('59.00');
  await advanced(page);
  await page.getByLabel('活动标题', { exact: true }).fill(`${title}（改名）`);
  await save(page);
  expect((await storefront(request, product.id)).promotion).toMatchObject({
    activityId: presaleId,
    price: '59.00',
  });

  await page.getByRole('switch', { name: '是否为拼单商品' }).click();
  await expect(page.getByRole('switch', { name: '是否为预售商品' })).not.toBeChecked();
  await pickEnd(page, '拼单活动结束时间');
  await page.getByLabel('成团总人数', { exact: true }).fill('3');
  await page.getByLabel('默认规格拼单价', { exact: true }).fill('49.00');
  await advanced(page);
  await page.getByLabel('活动标题', { exact: true }).fill(`${title} 拼单`);
  await save(page, true);
  const grouped = await storefront(request, product.id);
  expect(grouped.price).toBe('99.00');
  expect(grouped.promotion).toMatchObject({
    kind: 'groupbuy',
    price: '49.00',
    seatsRequired: 3,
    canBuy: true,
  });
  const old = await adminApi.get(`/admin-api/presale-activities/${presaleId}`);
  expect((await old.json()).status).toBe('ended');
  await settingsCard.screenshot({ path: testInfo.outputPath('groupbuy-settings.png') });

  await page.getByRole('switch', { name: '是否为拼单商品' }).click();
  await save(page, true);
  expect((await storefront(request, product.id)).promotion).toBeNull();
});

test('a draft presale is absent from the storefront list and cannot be read by id', async ({
  adminApi,
  request,
  shop,
}) => {
  const product = await createProduct(
    adminApi,
    shop.fixtures.productId!,
    `E2E 预售草稿 ${Date.now()}`,
  );
  const created = await adminApi.post('/admin-api/presale-activities', {
    data: {
      productId: product.id,
      title: product.name,
      status: 'draft',
      price: '49.00',
      stock: 5,
      startAt: new Date(Date.now() - 3600_000).toISOString(),
      endAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      skus: [{ skuId: product.skus[0]!.id, price: '49.00', stock: 5, isEnabled: true }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const listed = await request.get(
    `/api/v1/presale/activities?productId=${product.id}&page=1&pageSize=100`,
  );
  expect((await listed.json()).items).toEqual([]);
  expect((await request.get(`/api/v1/presale/activities/${id}`)).status()).toBe(404);
});
