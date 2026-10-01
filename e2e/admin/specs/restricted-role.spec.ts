import { test, expect, cjk, dialog, loginCookies, ORIGIN_HEADERS } from '../src/fixtures';
import { BASE_URL } from '../src/stack-file';

/**
 * A narrow role, made the way an operator would make it, and then held up
 * against both halves of the boundary: the menu it may see, and the API it
 * may call.
 *
 * The API half is the one that matters. The menu is a convenience — it is
 * filtered in the browser, from a permissions array the browser was handed —
 * so a menu test proves only that the UI is honest. The 403 on a direct call
 * proves the server does not care what the UI showed.
 */

const ROLE = 'E2E 只读运营';
const ACCOUNT = 'e2e-narrow';
const PASSWORD = 'e2e-Narrow0!';

test('a role with one atom sees one corner of the admin, and 403s everywhere else', async ({
  adminPage,
  playwright,
}) => {
  // ---- create the role, through the screen that creates roles ----
  await adminPage.goto('/admin/system/roles');
  await adminPage.getByRole('button', { name: '新建身份' }).click();

  const roleModal = dialog(adminPage);
  await expect(roleModal.getByText('新建身份')).toBeVisible();
  await roleModal.getByLabel('身份名称').fill(ROLE);
  // Exactly one atom. The section header checkbox would take the whole
  // section, which is the mistake this spec exists to notice.
  await roleModal.getByLabel('查看订单', { exact: true }).check();
  await roleModal.getByRole('button', { name: cjk('保存') }).click();
  await expect(roleModal).toBeHidden();
  await expect(adminPage.getByRole('cell', { name: ROLE })).toBeVisible();

  // ---- create an admin bound to it ----
  await adminPage.goto('/admin/system/admins');
  // Wait for the list to settle before clicking: the button is in the page
  // header, which renders before the table's first fetch resolves, and a click
  // dispatched into the middle of that render is a click into a detached node.
  await expect(adminPage.getByRole('cell', { name: 'e2e-super' })).toBeVisible();
  await adminPage.getByRole('button', { name: '新建管理员' }).click();

  const adminModal = dialog(adminPage);
  await adminModal.getByLabel('账号').fill(ACCOUNT);
  await adminModal.getByLabel('姓名').fill('只读运营');
  await adminModal.getByLabel('密码').fill(PASSWORD);
  await adminModal.getByLabel('身份').click();
  await adminPage.getByTitle(ROLE, { exact: true }).click();
  await adminPage.keyboard.press('Escape');
  await adminModal.getByRole('button', { name: cjk('保存') }).click();
  await expect(adminModal).toBeHidden();
  await expect(adminPage.getByRole('cell', { name: ACCOUNT })).toBeVisible();

  // ---- what that account sees ----
  const context = await adminPage.context().browser()!.newContext({ baseURL: BASE_URL });
  const narrowPage = await context.newPage();
  await narrowPage.goto('/admin/login');
  await narrowPage.getByLabel('账号').fill(ACCOUNT);
  await narrowPage.getByLabel('密码').fill(PASSWORD);
  await narrowPage.getByRole('button', { name: cjk('登录') }).click();
  await expect(narrowPage).toHaveURL(/\/admin$/);

  const menu = narrowPage.getByRole('menu');
  await expect(menu).toBeVisible();
  // The one thing it was granted.
  await expect(menu.getByText('订单', { exact: true })).toBeVisible();
  // Things it was not. `设置` would expose admins and roles — i.e. the ability
  // to grant itself everything else — so it is the one that must not be there.
  for (const forbidden of ['设置', '交易', '素材管理', '页面装修']) {
    await expect(menu.getByText(forbidden, { exact: true })).toHaveCount(0);
  }

  // A link to a screen outside the role is a 403 inside the chrome, not an
  // empty table and a toast per failed fetch.
  await narrowPage.goto('/admin/system/admins');
  await expect(narrowPage.getByText('抱歉，你没有权限访问该页面。')).toBeVisible();
  await expect(narrowPage.getByRole('menu')).toBeVisible();
  // … while the screen it was granted still renders.
  await narrowPage.goto('/admin/orders');
  await expect(narrowPage.getByText('抱歉，你没有权限访问该页面。')).toHaveCount(0);

  // 个人资料 in the avatar menu opens a page that exists, for any role.
  await narrowPage.getByTestId('user-menu').click();
  await narrowPage.getByRole('menuitem', { name: '个人资料' }).click();
  await expect(narrowPage).toHaveURL(/\/admin\/system\/profile$/);
  await expect(narrowPage.getByText('抱歉，你没有权限访问该页面。')).toHaveCount(0);

  // ---- and what it can actually call ----
  const narrowApi = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: ORIGIN_HEADERS,
  });
  await loginCookies(narrowApi, ACCOUNT, PASSWORD);

  // Granted: reading orders.
  expect((await narrowApi.get('/admin-api/orders?page=1&pageSize=10')).status()).toBe(200);
  // Implicit, and must stay implicit: its own profile and session.
  expect((await narrowApi.get('/admin-api/auth/me')).status()).toBe(200);

  // Not granted. Each of these is a different domain's read, so a single
  // mistake in one domain's `requirePermission` cannot make the whole set
  // pass. The last one is the ladder: creating an admin.
  for (const url of [
    '/admin-api/roles?page=1&pageSize=10',
    '/admin-api/admins?page=1&pageSize=10',
    '/admin-api/refunds?page=1&pageSize=10',
    '/admin-api/attachments?page=1&pageSize=10',
    '/admin-api/system/config/sms',
    '/admin-api/audit-logs?page=1&pageSize=10',
  ]) {
    const response = await narrowApi.get(url);
    expect(response.status(), url).toBe(403);
    expect((await response.json()).code, url).toBe('FORBIDDEN');
  }

  const escalation = await narrowApi.post('/admin-api/admins', {
    data: {
      account: 'e2e-escalation',
      name: '不该存在',
      password: 'e2e-Escalate0!',
      roleIds: [],
      enabled: true,
    },
  });
  expect(escalation.status(), 'a narrow role must not be able to mint a wider one').toBe(403);

  await narrowApi.dispose();
  await context.close();
});

test('the 403 page says what happened rather than showing an empty shell', async ({
  adminPage,
}) => {
  await adminPage.goto('/admin/403');
  await expect(adminPage.getByText('抱歉，你没有权限访问该页面。')).toBeVisible();
  await expect(adminPage.getByRole('link', { name: '返回首页' })).toBeVisible();
});
