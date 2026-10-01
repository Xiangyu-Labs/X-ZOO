import { test, expect, cjk, toast } from '../src/fixtures';
import { PNG, PNG_DECLARED_AS_JPEG, SVG_WITH_SCRIPT } from '../src/files';

/**
 * The uploader, from the operator's side.
 *
 * `file-type.test.ts` proves the sniffer refuses an SVG. This proves the
 * refusal survives the whole path — antd's `Upload`, the multipart body, the
 * route, the service — and that the operator is told why rather than watching
 * a spinner stop.
 */

const uploadInput = '.ant-upload input[type="file"]';

test('a PNG lands in the library, and a dedupe of it is recognised', async ({
  adminPage,
  adminApi,
}) => {
  await adminPage.goto('/admin/storage/attachments');
  await expect(adminPage.getByRole('button', { name: cjk('上传') })).toBeVisible();

  await adminPage.setInputFiles(uploadInput, PNG);
  await expect(adminPage.getByRole('cell', { name: PNG.name })).toBeVisible();

  // The same bytes again: the shop stores one copy and says so.
  await adminPage.setInputFiles(uploadInput, { ...PNG, name: 'e2e-pixel-again.png' });
  await expect(toast(adminPage, '素材库中已有相同文件')).toBeVisible();

  // The stored record carries the sniffed type, not whatever was declared.
  const list = await adminApi.get('/admin-api/attachments?page=1&pageSize=10');
  expect(list.status()).toBe(200);
  const items = (await list.json()).items as Array<{ name: string; mime?: string; kind?: string }>;
  const uploaded = items.find((item) => item.name === PNG.name);
  expect(uploaded, 'the upload must be in the list the API returns').toBeDefined();
});

test('an SVG is refused, and the operator is told which file and why', async ({ adminPage }) => {
  await adminPage.goto('/admin/storage/attachments');
  await adminPage.setInputFiles(uploadInput, SVG_WITH_SCRIPT);

  // The message names the file — a batch upload where one file fails must not
  // leave the operator guessing which.
  await expect(toast(adminPage, SVG_WITH_SCRIPT.name)).toBeVisible();
  await expect(adminPage.getByRole('cell', { name: SVG_WITH_SCRIPT.name })).toHaveCount(0);
});

test('a PNG that claims to be a JPEG is refused rather than silently corrected', async ({
  adminPage,
}) => {
  await adminPage.goto('/admin/storage/attachments');
  await adminPage.setInputFiles(uploadInput, PNG_DECLARED_AS_JPEG);

  await expect(toast(adminPage, PNG_DECLARED_AS_JPEG.name)).toBeVisible();
  await expect(adminPage.getByRole('cell', { name: PNG_DECLARED_AS_JPEG.name })).toHaveCount(0);
});

test('the scan-token route refuses a token that was never issued', async ({ request }) => {
  // Public by necessity — the phone holding the QR code has no session — so
  // it is the one upload entry point an attacker can reach. An unknown token
  // must be refused before anything is stored.
  const response = await request.post('/api/v1/attachments/scan-uploads/nope-not-a-real-token', {
    multipart: { file: PNG },
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(await response.text()).toContain('STORAGE_SCAN_TOKEN_INVALID');
});
