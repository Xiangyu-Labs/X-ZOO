import type { APIRequestContext, Page } from '@playwright/test';

import { test, expect, cjk, toast } from '../src/fixtures';

/**
 * 店铺装修: the admin editor against the real server and the
 * storefront's own read of what it published.
 *
 * The page document is written by the editor and served by
 * `GET /api/v1/pages/…`; nothing but reading it back proves that what the
 * operator published is what a shopper gets — and that a rollback or a new
 * home page takes effect at once.
 */

interface ServedPage {
  id: string | null;
  revision: number | null;
  preview: boolean;
  root: { props: { title: string } };
}

async function served(request: APIRequestContext, path: string): Promise<ServedPage> {
  const response = await request.get(path);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ServedPage;
}

/** The storefront's title for the page, or its HTTP status when it serves none. */
async function servedTitle(request: APIRequestContext, id: string): Promise<string | number> {
  const response = await request.get(`/api/v1/pages/${id}`);
  if (response.status() !== 200) return response.status();
  return ((await response.json()) as ServedPage).root.props.title;
}

/**
 * The root panel is what the inspector shows with no block selected. Puck
 * draws its inspector twice (the desktop sidebar and the narrow-screen
 * drawer), so the field is the visible one.
 */
async function setTitle(page: Page, title: string) {
  const field = page.locator('input[title="页面标题"]:visible');
  await field.fill(title);
  await expect(page.getByText('未保存')).toBeVisible();
}

async function publish(page: Page, note: string, expected: number) {
  await page.getByRole('button', { name: cjk('发布') }).click();
  const modal = page.getByRole('dialog', { name: '发布页面' });
  await modal.getByLabel('发布说明').fill(note);
  await modal.getByRole('button', { name: /^(发\s*布|保存并发布)$/ }).click();
  await expect(toast(page, `已发布第 ${expected} 版`)).toBeVisible();
  await expect(modal).toBeHidden();
}

test('DECOR-011 DECOR-014: create, save, publish, publish again and roll back — the storefront follows each step', async ({
  adminPage: page,
  request,
}) => {
  const name = `E2E 装修 ${Date.now()}`;
  await page.goto('/admin/decor');
  await expect(page.getByText('小程序的首页、个人中心与微页面')).toBeVisible();
  await page.getByRole('button', { name: '新建页面' }).click();
  const create = page.getByRole('dialog');
  await create.getByLabel('页面名称').fill(name);
  await create.getByRole('button', { name: '创建并装修' }).click();
  await expect(page).toHaveURL(/\/admin\/decor\/\d+$/);
  const id = page.url().split('/').pop()!;
  await expect(page.getByTestId('decor-page-editor')).toBeVisible();

  // An edit is not saved until 保存草稿, and a saved draft is not served.
  await setTitle(page, 'E2E 第一版');
  await page.getByRole('button', { name: cjk('保存草稿') }).click();
  await expect(toast(page, '草稿已保存')).toBeVisible();
  await expect(page.getByText('未保存')).toHaveCount(0);
  expect(await servedTitle(request, id), 'a draft must not reach a shopper').toBe(404);

  await publish(page, '第一版', 1);
  expect(await servedTitle(request, id)).toBe('E2E 第一版');

  // Publishing with unsaved changes saves them first.
  await setTitle(page, 'E2E 第二版');
  await publish(page, '第二版', 2);
  const second = await served(request, `/api/v1/pages/${id}`);
  expect(second.root.props.title).toBe('E2E 第二版');
  expect(second.revision).toBe(2);

  // Roll back to 1: a third revision with the first one's content, served at once.
  await page.getByRole('button', { name: cjk('发布记录') }).click();
  const first = page.getByTestId('decor-revision-1');
  await first.getByRole('button', { name: cjk('回滚') }).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: cjk('确定') })
    .click();
  await expect(toast(page, '已回滚：线上现在是第 3 版')).toBeVisible();
  // The draft is untouched until the operator asks for the old content.
  await page.getByRole('button', { name: cjk('保持草稿') }).click();

  const rolledBack = await served(request, `/api/v1/pages/${id}`);
  expect(rolledBack.root.props.title).toBe('E2E 第一版');
  expect(rolledBack.revision).toBe(3);
  await expect(page.getByTestId('decor-revision-3')).toContainText('回滚自第 1 版');

  const detail = await page.request.get(`/admin-api/decor/documents/${id}`);
  const draft = (await detail.json()) as {
    draft: { root: { props: { title: string } } };
    hasUnpublishedChanges: boolean;
  };
  expect(draft.draft.root.props.title, 'a rollback leaves the draft as it was').toBe('E2E 第二版');
  expect(draft.hasUnpublishedChanges).toBe(true);

  // Looking at a revision is read-only and does not touch the draft.
  await first.getByRole('button', { name: cjk('查看') }).click();
  await expect(page.getByText('查看第 1 版（只读）')).toBeVisible();
  await page.getByRole('button', { name: '返回编辑' }).click();
  await expect(page.getByText('查看第 1 版（只读）')).toHaveCount(0);
});

test('DECOR-012: the preview frames the saved draft through a preview token', async ({
  adminPage: page,
  adminApi,
  request,
}) => {
  const created = await adminApi.post('/admin-api/decor/documents', {
    data: { kind: 'custom', name: `E2E 预览 ${Date.now()}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await page.goto(`/admin/decor/${id}`);
  await setTitle(page, 'E2E 预览草稿');
  // Preview shows what is stored, so an unsaved edit is saved first.
  await page.getByRole('button', { name: cjk('预览') }).click();
  await expect(page.getByText('未保存')).toHaveCount(0);

  // The e2e stack points `DECOR_PREVIEW_URL` at the storefront's own read of
  // the page, so the frame holds exactly what the H5 build would receive.
  const frame = page.frameLocator('[data-testid="decor-preview-frame"]');
  await expect(frame.locator('body')).toContainText('"preview":true');
  await expect(frame.locator('body')).toContainText('E2E 预览草稿');
  await expect(page.getByTestId('decor-preview-path')).toContainText(
    `packages/page/index?id=${id}&previewToken=`,
  );

  // Without the token the page, never published, does not exist.
  expect(await servedTitle(request, id)).toBe(404);
});

test('DECOR-008: designating a published page as 首页 serves it as the home page', async ({
  adminPage: page,
  adminApi,
  request,
}) => {
  const name = `E2E 首页 ${Date.now()}`;
  const created = await adminApi.post('/admin-api/decor/documents', {
    data: { kind: 'home', name },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await page.goto('/admin/decor');
  const row = page.getByRole('row').filter({ hasText: name });
  // Unpublished: nothing to serve yet, so it cannot be designated.
  await expect(row.getByRole('button', { name: '设为首页' })).toBeDisabled();

  const published = await adminApi.post(`/admin-api/decor/documents/${id}/publish`, {
    data: { note: '' },
  });
  expect(published.status(), await published.text()).toBe(200);
  await page.reload();

  await row.getByRole('button', { name: '设为首页' }).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: cjk('确定') })
    .click();
  await expect(toast(page, '已启用')).toBeVisible();
  await expect(row.getByText('当前首页')).toBeVisible();
  // The page in use cannot be deleted.
  await expect(row.getByRole('button', { name: cjk('删除') })).toBeDisabled();

  const home = await served(request, '/api/v1/pages/home');
  expect(home.id).toBe(id);
  expect(home.preview).toBe(false);
});
