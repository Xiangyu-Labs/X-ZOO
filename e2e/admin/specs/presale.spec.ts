import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { test, expect, cjk, dialog, toast } from '../src/fixtures';

/**
 * 预售 — an activity made on the admin screen, read back through the
 * storefront API a shopper's app calls.
 *
 * What only this suite can see: that the form's 规格 rows, dates and money
 * fields reach the server in the shape the contract wants (the component test
 * stubs `fetch`), that the storefront then sells at the *presale* price, that
 * an edit through the dialog keeps those prices (the list row carries no 规格,
 * so a dialog opened on it and saved would delete them all),
 * and that 暂停 takes the campaign off sale at once.
 *
 * The seeded product (`E2E 订单用商品`, one SKU at ¥99.00) is the one on sale.
 */

test.describe.configure({ mode: 'serial' });

const serial = Date.now() % 1_000_000_000;
const TITLE = `E2E 预售 ${serial}`;
const RENAMED = `E2E 预售（改名）${serial}`;

/** `YYYY-MM-DD HH:mm:ss` in Asia/Shanghai, which is what the picker displays and parses. */
function shanghai(offsetMs: number): string {
  return new Date(Date.now() + offsetMs + 8 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

async function pickDate(modal: Locator, label: string, value: string): Promise<void> {
  const input = modal.getByLabel(label, { exact: true });
  await input.click();
  await input.fill(value);
  await input.press('Enter');
  await expect(input).toHaveValue(value);
}

interface Card {
  activityId: string;
  title: string;
  price: string;
  canBuy: boolean;
}

async function storefrontList(request: APIRequestContext): Promise<Card[]> {
  const response = await request.get('/api/v1/presale/activities?page=1&pageSize=100');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: Card[] }).items;
}

async function activityIdByTitle(api: APIRequestContext, title: string): Promise<string> {
  const response = await api.get(
    `/admin-api/presale-activities?page=1&pageSize=20&keyword=${encodeURIComponent(title)}`,
  );
  expect(response.status()).toBe(200);
  const items = ((await response.json()) as { items: Array<{ id: string; title: string }> }).items;
  const row = items.find((item) => item.title === title);
  expect(row, `no activity titled ${title}`).toBeDefined();
  return row!.id;
}

function row(page: Page, title: string): Locator {
  return page.getByRole('row').filter({ hasText: title });
}

test('an activity made on the screen is on sale in the storefront at the presale price', async ({
  adminPage,
  adminApi,
  request,
  shop,
}) => {
  await adminPage.goto('/admin/presale/activities');
  await adminPage.getByRole('button', { name: cjk('新建预售活动') }).click();
  const modal = dialog(adminPage);
  await expect(modal.getByText('新建预售活动')).toBeVisible();

  // 商品 is a search: a pasted id finds the product, which is then picked by name.
  await modal.getByLabel('商品', { exact: true }).fill(String(shop.fixtures.productId));
  await adminPage.getByTitle(`E2E 订单用商品（#${shop.fixtures.productId}）`).click();
  await modal.getByLabel('活动标题', { exact: true }).fill(TITLE);
  await modal.getByLabel('状态', { exact: true }).click();
  await adminPage.getByTitle('进行中', { exact: true }).click();
  await modal.getByLabel('预售价', { exact: true }).fill('59.00');
  await modal.getByLabel('活动库存', { exact: true }).fill('10');
  await pickDate(modal, '开始时间', shanghai(-3_600_000));
  await pickDate(modal, '结束时间', shanghai(7 * 86_400_000));

  // One 规格 row: the seeded SKU at the presale price.
  await modal.getByRole('button', { name: cjk('添加规格') }).click();
  await modal.getByPlaceholder('规格 ID', { exact: true }).fill(String(shop.fixtures.skuId));
  await modal.getByPlaceholder('预售价', { exact: true }).fill('59');
  await modal.getByPlaceholder('库存', { exact: true }).fill('10');

  await modal.getByRole('button', { name: cjk('保存') }).click();
  await expect(toast(adminPage, '已保存')).toBeVisible();
  await expect(modal).toBeHidden();
  await expect(row(adminPage, TITLE).getByText('进行中')).toBeVisible();

  // The storefront: listed, buyable, at 59.00 — and the SKU at 59.00 with the
  // catalogue's 99.00 as the struck-through price.
  const id = await activityIdByTitle(adminApi, TITLE);
  const card = (await storefrontList(request)).find((item) => item.activityId === id);
  expect(card).toMatchObject({ title: TITLE, price: '59.00', canBuy: true });

  const detail = await request.get(`/api/v1/presale/activities/${id}`);
  expect(detail.status()).toBe(200);
  const body = await detail.json();
  expect(body.canBuy).toBe(true);
  expect(body.skus).toEqual([
    expect.objectContaining({
      skuId: String(shop.fixtures.skuId),
      price: '59.00',
      originalPrice: '99.00',
      stock: 10,
    }),
  ]);
});

test('editing the title through the dialog keeps every presale price', async ({
  adminPage,
  adminApi,
  request,
  shop,
}) => {
  await adminPage.goto(`/admin/presale/activities?keyword=${encodeURIComponent(TITLE)}`);
  await row(adminPage, TITLE)
    .getByRole('button', { name: cjk('编辑') })
    .click();
  const modal = dialog(adminPage);
  // The dialog loads the whole activity before it shows a field; the 规格 row
  // being there is the evidence it did.
  const title = modal.getByLabel('活动标题', { exact: true });
  await expect(title).toHaveValue(TITLE);
  await expect(modal.getByPlaceholder('规格 ID', { exact: true })).toHaveValue(
    String(shop.fixtures.skuId),
  );

  await title.fill(RENAMED);
  await modal.getByRole('button', { name: cjk('保存') }).click();
  await expect(toast(adminPage, '已保存')).toBeVisible();
  await expect(modal).toBeHidden();

  const id = await activityIdByTitle(adminApi, RENAMED);
  const body = await (await request.get(`/api/v1/presale/activities/${id}`)).json();
  expect(body.title).toBe(RENAMED);
  expect(body.skus).toHaveLength(1);
  expect(body.skus[0]).toMatchObject({ skuId: String(shop.fixtures.skuId), price: '59.00' });
});

test('暂停 takes the campaign off sale at once', async ({ adminPage, adminApi, request }) => {
  await adminPage.goto(`/admin/presale/activities?keyword=${encodeURIComponent(RENAMED)}`);
  const line = row(adminPage, RENAMED);
  await line.getByRole('button', { name: cjk('暂停') }).click();
  // Taking a campaign off sale is customer-visible, so it asks first.
  await adminPage
    .getByRole('tooltip')
    .getByRole('button', { name: cjk('暂停') })
    .click();
  await expect(toast(adminPage, '已暂停')).toBeVisible();
  await expect(line.getByText('已暂停')).toBeVisible();

  const id = await activityIdByTitle(adminApi, RENAMED);
  expect((await storefrontList(request)).some((item) => item.activityId === id)).toBe(false);
  const detail = await request.get(`/api/v1/presale/activities/${id}`);
  // Whatever the detail route answers for a paused campaign, it must not sell it.
  if (detail.status() === 200) expect((await detail.json()).canBuy).toBe(false);
  else expect(detail.status()).toBe(404);

  // And 启用 puts it back.
  await line.getByRole('button', { name: cjk('启用') }).click();
  await expect(line.getByText('进行中')).toBeVisible();
  const card = (await storefrontList(request)).find((item) => item.activityId === id);
  expect(card?.canBuy).toBe(true);
});

test('a draft is not on the storefront, not even by id', async ({ adminApi, request, shop }) => {
  // The list filters on status and window, and `detail` answers 404 for a
  // draft too — ids are sequential, and the form promises
  // 「草稿不会出现在前台」 and the error 「不存在或已下架」.

  // Arranged through the API: making an activity on the screen is the first
  // case's subject.
  const created = await adminApi.post('/admin-api/presale-activities', {
    data: {
      productId: String(shop.fixtures.productId),
      title: `E2E 预售草稿 ${serial}`,
      status: 'draft',
      price: '49.00',
      stock: 5,
      startAt: new Date(Date.now() - 3_600_000).toISOString(),
      endAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      skus: [{ skuId: String(shop.fixtures.skuId), price: '49.00', stock: 5, isEnabled: true }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;

  expect((await storefrontList(request)).some((item) => item.activityId === id)).toBe(false);
  const detail = await request.get(`/api/v1/presale/activities/${id}`);
  expect(detail.status()).toBe(404);
});
