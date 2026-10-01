import { wechatOaConfig } from '@shop/core/system';
import { wechatConfig } from '@shop/core/wechat';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import type { APIRequestContext, Page } from '@playwright/test';

import { test, expect, cjk, dialog, toast } from '../src/fixtures';
import { stack } from '../src/stack';

/**
 * 公众号自定义菜单 — save is a draft, 发布 is the only thing that reaches
 * WeChat, and a refusal from WeChat is something the operator can read.
 *
 * WeChat here is `@shop/testing`'s fake OA server on a local port. The seed
 * points `wechat.apiBaseUrl` at a closed port; this spec re-points it at the
 * fake for its own duration and puts the black hole back afterwards, so no
 * other spec can reach even the fake by accident. The AppID/AppSecret are the
 * fake's own pair — a real one would not get a token from it.
 *
 * Configuration is arranged through `ctx.config.set` rather than the settings
 * screen: the settings form is `config-secrets.spec.ts`'s subject, and
 * `apiBaseUrl` has no screen at all (it is not an operator setting).
 */

// The three cases are one journey: the second republishes the menu the first
// made live, so a failure early on should skip the rest rather than cascade.
test.describe.configure({ mode: 'serial' });

let fake: FakeOaServer;
const serial = Date.now() % 1_000_000_000;
const BLACK_HOLE = 'http://127.0.0.1:9/no-wechat';

async function configureOa(enabled: boolean): Promise<void> {
  const { ctx } = await stack();
  await ctx.config.set(wechatConfig, {
    apiBaseUrl: enabled ? fake.url : BLACK_HOLE,
    oaAppId: enabled ? fake.appId : '',
    oaAppSecret: enabled ? fake.appSecret : '',
  });
  await ctx.config.set(wechatOaConfig, { enabled });
}

test.beforeAll(async () => {
  fake = await startFakeOaServer();
  // Start unconfigured, whatever a reused stack was left holding.
  await configureOa(false);
  // …but aimed at the fake, so an unconfigured publish that reached out anyway
  // would show up in `fake.calls` instead of vanishing into the black hole.
  const { ctx } = await stack();
  await ctx.config.set(wechatConfig, { apiBaseUrl: fake.url });
});

test.afterAll(async () => {
  await configureOa(false);
  await fake.close();
});

test.beforeEach(() => {
  fake.reset();
});

async function menuByName(api: APIRequestContext, name: string) {
  const response = await api.get('/admin-api/wechat-menus?page=1&pageSize=100');
  expect(response.status()).toBe(200);
  const items = ((await response.json()) as { items: Array<{ id: string; name: string }> }).items;
  const menu = items.find((item) => item.name === name);
  expect(menu, `menu ${name} is not in the list`).toBeDefined();
  return menu!;
}

/** 新建菜单 with one 跳转网页 button, through the dialog. */
async function saveDraft(page: Page, name: string, button: string, url: string): Promise<void> {
  await page.goto('/admin/wechat-oa/menu');
  await page.getByRole('button', { name: cjk('新建菜单') }).click();
  const modal = dialog(page);
  await modal.getByLabel('名称', { exact: true }).fill(name);
  await modal.getByLabel('一级按钮 1 名称').fill(button);
  await modal.getByLabel('一级按钮 1 网页地址').fill(url);
  await modal.getByRole('button', { name: cjk('保存') }).click();
  await expect(toast(page, '已保存草稿')).toBeVisible();
  await expect(modal).toBeHidden();
}

async function publish(page: Page, name: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: cjk('发布') }).click();
  await page
    .getByRole('tooltip')
    .getByRole('button', { name: cjk('发布') })
    .click();
}

test('a saved menu is a draft; 发布 is refused until the account is configured, then goes live', async ({
  adminPage,
  adminApi,
}) => {
  const name = `春节菜单 ${serial}`;
  await saveDraft(adminPage, name, '领红包', 'https://shop.example.com/spring');

  // Saving reached nobody.
  expect(fake.calls).toEqual([]);
  const row = adminPage.getByRole('row').filter({ hasText: name });
  await expect(row.getByText('草稿')).toBeVisible();
  await expect(row.getByText('领红包')).toBeVisible();

  // Unconfigured: refused in the shop, before any call leaves it.
  await publish(adminPage, name);
  await expect(toast(adminPage, '公众号尚未配置，请先在系统设置中填写')).toBeVisible();
  expect(fake.calls).toEqual([]);
  await expect(row.getByText('草稿')).toBeVisible();

  // Configured: WeChat receives exactly the tree that was typed.
  await configureOa(true);
  await publish(adminPage, name);
  await expect(toast(adminPage, '已发布到微信')).toBeVisible();
  await expect(row.getByText('已生效')).toBeVisible();

  expect(fake.callsTo('/cgi-bin/menu/create')).toHaveLength(1);
  expect(fake.publishedMenu).toEqual([
    { name: '领红包', type: 'view', url: 'https://shop.example.com/spring' },
  ]);
  // The token it used is one the fake issued, i.e. the shop fetched it with
  // the configured AppID/AppSecret rather than inventing one.
  const [call] = fake.callsTo('/cgi-bin/menu/create');
  expect(fake.tokens).toContain(call!.accessToken);

  // Publishing is an admin write, so it names the menu in the audit log.
  const menu = await menuByName(adminApi, name);
  const audit = await adminApi.get('/admin-api/audit-logs?page=1&pageSize=20');
  const targets = ((await audit.json()).items as Array<{ target: string | null }>).map(
    (entry) => entry.target,
  );
  expect(targets.some((target) => target?.includes(menu.id))).toBe(true);
});

test('WeChat refusing the live menu is shown on the page, with its errcode', async ({
  adminPage,
}) => {
  await configureOa(true);
  const name = `春节菜单 ${serial}`;
  await adminPage.goto('/admin/wechat-oa/menu');
  const row = adminPage.getByRole('row').filter({ hasText: name });
  await expect(row.getByText('已生效')).toBeVisible();

  fake.behaviour.failMenu = { errcode: 40016, errmsg: 'invalid button size' };
  const [refused] = await Promise.all([
    adminPage.waitForResponse((response) => response.url().endsWith('/publish')),
    publish(adminPage, name),
  ]);
  expect(refused.status()).toBe(502);
  expect(((await refused.json()) as { code: string }).code).toBe('WECHAT_OA_API_FAILED');

  // The toast goes in three seconds; the alert is what stays. 发布 re-reads
  // `/current` on a refusal too, so it appears without a reload…
  const alert = adminPage.getByRole('alert').filter({ hasText: '上次发布失败' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('40016');
  // …and it is still there for the operator coming back to the page.
  await adminPage.reload();
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('40016');
  // WeChat kept the old menu, and so does the row.
  await expect(row.getByText('已生效')).toBeVisible();
  expect(fake.publishedMenu).toBeNull();
});

test('WeChat refusing a new draft is shown on the page too', async ({ adminPage }) => {
  // `publish_error` is written to the draft's row, and the alert reads
  // `/wechat-menus/current` — the *live* menu. So the refusal is shown on the
  // draft's own row in the 状态 column, where 发布 was pressed.

  await configureOa(true);
  // Clear the live menu's own error from the case above: republishing it
  // successfully resets `publish_error`, so any 40016 on the page afterwards
  // can only be the draft's.
  await adminPage.goto('/admin/wechat-oa/menu');
  const [accepted] = await Promise.all([
    adminPage.waitForResponse((response) => response.url().endsWith('/publish')),
    publish(adminPage, `春节菜单 ${serial}`),
  ]);
  expect(accepted.status()).toBe(200);
  await adminPage.reload();
  await expect(adminPage.getByText('上次发布失败')).toHaveCount(0);

  const name = `清明菜单 ${serial}`;
  await saveDraft(adminPage, name, '踏青', 'https://shop.example.com/qingming');

  fake.behaviour.failMenu = { errcode: 40016, errmsg: 'invalid button size' };
  const [refused] = await Promise.all([
    adminPage.waitForResponse((response) => response.url().endsWith('/publish')),
    publish(adminPage, name),
  ]);
  // Refused for the reason arranged, so the assertion below fails for the CR's
  // reason and not for a broken arrangement.
  expect(refused.status()).toBe(502);

  // On the draft's row as soon as the refusal is back, with no reload…
  const row = adminPage.getByRole('row').filter({ hasText: name });
  await expect(row.getByText('发布失败')).toBeVisible();
  await expect(row.getByText('40016')).toBeVisible();
  // …after one, and nowhere else: the live menu was not the one refused.
  await adminPage.reload();
  await expect(adminPage.getByText('40016')).toBeVisible({ timeout: 5_000 });
  await expect(row.getByText('40016')).toBeVisible();
  await expect(adminPage.getByText('上次发布失败')).toHaveCount(0);
});
