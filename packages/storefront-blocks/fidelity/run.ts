/**
 * Fidelity check for the DIY v2 blocks (S3, extended to every block in G1 and G2). Not part of CI.
 *
 * Screenshots each block, at a 375 px wide phone, from
 *
 *   1. the admin editor canvas: `/admin/dev/decor-spike`, inside Puck's iframe,
 *      where the blocks render through the DOM shim with the px → vw
 *      stylesheet; and, when `--h5` is given,
 *   2. the Taro H5 build: a dev page that renders the same fixtures with the
 *      real `@tarojs/components` and pxtransform,
 *
 * and diffs each pair with pixelmatch. Both pages must put `data-block="<type>"`
 * on each block's outer element (the blocks do so themselves).
 *
 *   pnpm --filter @shop/web build && pnpm --filter @shop/web start   # :3000
 *   pnpm --filter @shop/storefront-blocks fidelity -- \
 *     --admin http://localhost:3000 \
 *     [--h5 'http://localhost:10086/#/subpackages/demo/pages/blocks/index?canvas=1'] \
 *     [--out ../../docs/mini/spikes/S3]
 *
 * The H5 page takes `?canvas=1` so it draws what the editor canvas draws (a
 * guest, a video's poster, 悬浮客服 in the flow, no countdown).
 *
 * The admin session is client-side (`GET /admin-api/auth/me`); the script
 * answers every `/admin-api/*` request itself, so no database or sign-in is
 * needed and nothing leaves the machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { chromium, type Frame, type Locator, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Every block, in the order both pages draw them (the spike page and the mini demo page). */
const BLOCKS = [
  'searchBar',
  'carousel',
  'navGrid',
  'notice',
  'titleBar',
  'productGrid',
  'imageCube',
  'hotspotImage',
  'productTabs',
  'spacer',
  'richText',
  'userCard',
  'orderEntry',
  'serviceGrid',
  'couponList',
  'newcomerCoupon',
  'groupbuyList',
  'presaleList',
  'articleList',
  'video',
  'floatingContact',
  'followOfficialAccount',
] as const;
const LAST_BLOCK: Block = 'followOfficialAccount';
/** Tall enough for the whole fixture page at 375 px, so no block is clipped. */
const PAGE_HEIGHT = 6000;
type Block = (typeof BLOCKS)[number];

const { values } = parseArgs({
  options: {
    admin: { type: 'string', default: 'http://localhost:3000' },
    h5: { type: 'string' },
    out: { type: 'string', default: 'fidelity/.out' },
    threshold: { type: 'string', default: '0.1' },
    /** A block whose mismatch is above this percentage is flagged. */
    flag: { type: 'string', default: '3' },
  },
});

/** Progress goes to stdout: this is a CLI, not library code. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

const out = resolve(values.out);
mkdirSync(out, { recursive: true });

/** The contract example for `GET /admin-api/auth/me`: a super admin. */
const ME = {
  id: '1',
  account: 'admin',
  name: '超级管理员',
  avatar: null,
  isSuper: true,
  permissions: [],
};

async function stubAdminApi(page: Page): Promise<void> {
  await page.route('**/admin-api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin-api/auth/me') {
      await route.fulfill({ json: ME });
    } else if (url.pathname.endsWith('/stream')) {
      await route.abort();
    } else {
      await route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: 'fidelity stub' } });
    }
  });
}

/**
 * Waits until every `<img>` inside a block has decoded. Only block images: the
 * H5 shell has `<img>`s of its own (the tab bar's) without a `src`.
 */
async function imagesSettled(frame: Frame | Page): Promise<void> {
  await frame.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('[data-block] img')).every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
}

/**
 * Waits until every record list has its records: the canvas answers its data
 * needs asynchronously, and until then a list says it is empty.
 */
async function recordsSettled(frame: Frame | Page): Promise<void> {
  await frame.waitForFunction(
    () => !(document.body.textContent ?? '').includes('商城中不显示此组件'),
  );
}

/**
 * Screenshots a block, clipped to its box snapped to device pixels (DPR 2).
 * Not an element screenshot: that rounds the box out to whole CSS pixels, and
 * vw lengths come out a hair short (169.98 px for 170), so the two sides would
 * differ by a row of whatever lies below the block.
 */
async function shootBlock(page: Page, block: Locator): Promise<Buffer> {
  const box = await block.boundingBox();
  if (!box) throw new Error('the block is not rendered');
  const snap = (value: number): number => Math.round(value * 2) / 2;
  const clip = { x: snap(box.x), y: snap(box.y), width: snap(box.width), height: snap(box.height) };
  return page.screenshot({ clip });
}

async function shootAdmin(): Promise<Record<Block, Buffer>> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 2,
    });
    await stubAdminApi(page);
    await page.goto(new URL('/admin/dev/decor-spike', values.admin).href);
    const frameElement = await page.waitForSelector('[data-testid="decor-editor"] iframe', {
      timeout: 60_000,
    });
    const frame = await frameElement.contentFrame();
    if (!frame) throw new Error('the editor canvas iframe has no frame');
    await frame.waitForSelector(`[data-block="${LAST_BLOCK}"]`);
    await recordsSettled(frame);
    // Nothing hovered or selected: Puck draws outlines over the canvas otherwise.
    await page.mouse.move(0, 0);
    const width = await frame.evaluate(() => document.documentElement.clientWidth);
    let box = await frameElement.boundingBox();
    if (box && Math.round(box.width) !== width) {
      // Puck zooms the canvas out when the editor is narrow; shots must be at 100 %.
      await page.locator('select:has(option[value="1"])').first().selectOption('1');
      await page.waitForTimeout(500);
      box = await frameElement.boundingBox();
    }
    say(`admin canvas: ${width}px wide, iframe box ${JSON.stringify(box)}`);
    if (!box || Math.round(box.width) !== width) {
      throw new Error(`the canvas is zoomed (${box?.width ?? '?'} px on screen for ${width} px)`);
    }
    writeFileSync(resolve(out, 'admin-editor.png'), await page.screenshot());
    // A block taller than the canvas would be clipped by the editor's own
    // scroll box: stretch the editor so the whole page fits, then shoot.
    await page.setViewportSize({ width: 1920, height: PAGE_HEIGHT + 1200 });
    await page.locator('[data-testid="decor-editor"]').evaluate((element, height) => {
      (element as HTMLElement).style.height = `${height}px`;
    }, PAGE_HEIGHT);
    await page.waitForTimeout(500);
    await page.mouse.move(0, 0);
    // Put the canvas on the device-pixel grid: the editor lays it out at a
    // fractional y (379.14), and a clip across that seam blends two rows.
    const top = (await frameElement.boundingBox())?.y ?? 0;
    const nudge = Math.ceil(top * 2) / 2 - top;
    await page.locator('[data-testid="decor-editor"]').evaluate((element, px) => {
      (element as HTMLElement).style.marginTop = `${px}px`;
    }, nudge);
    await page.waitForTimeout(200);
    // Only now: list pictures load lazily, and the lower ones only come into
    // range once the editor is stretched to the whole page.
    await imagesSettled(frame);
    const shots = {} as Record<Block, Buffer>;
    for (const block of BLOCKS) {
      shots[block] = await shootBlock(page, frame.locator(`[data-block="${block}"]`).first());
      writeFileSync(resolve(out, `admin-${block}.png`), shots[block]);
    }
    return shots;
  } finally {
    await browser.close();
  }
}

async function shootH5(url: string): Promise<Record<Block, Buffer>> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      // Tall enough that every block is on screen: `shootBlock` clips the viewport.
      viewport: { width: 375, height: PAGE_HEIGHT },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await page.goto(url);
    await page.waitForSelector(`[data-block="${LAST_BLOCK}"]`, { timeout: 60_000 });
    await recordsSettled(page);
    await imagesSettled(page);
    const shots = {} as Record<Block, Buffer>;
    for (const block of BLOCKS) {
      shots[block] = await shootBlock(page, page.locator(`[data-block="${block}"]`).first());
      writeFileSync(resolve(out, `h5-${block}.png`), shots[block]);
    }
    return shots;
  } finally {
    await browser.close();
  }
}

interface DiffResult {
  block: Block;
  admin: string;
  h5: string;
  mismatched: number;
  total: number;
  percent: number;
}

/** Diffs two screenshots over their common area; a size difference is reported, not hidden. */
function diff(block: Block, adminPng: Buffer, h5Png: Buffer): DiffResult {
  const a = PNG.sync.read(adminPng);
  const b = PNG.sync.read(h5Png);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const crop = (png: PNG): Buffer => {
    const target = new PNG({ width, height });
    PNG.bitblt(png, target, 0, 0, width, height, 0, 0);
    return target.data;
  };
  const output = new PNG({ width, height });
  const mismatched = pixelmatch(crop(a), crop(b), output.data, width, height, {
    threshold: Number(values.threshold),
  });
  writeFileSync(resolve(out, `diff-${block}.png`), PNG.sync.write(output));
  // Pixels outside the common area are all mismatches.
  const total = Math.max(a.width, b.width) * Math.max(a.height, b.height);
  const all = mismatched + (total - width * height);
  return {
    block,
    admin: `${a.width}×${a.height}`,
    h5: `${b.width}×${b.height}`,
    mismatched: all,
    total,
    percent: Math.round((all / total) * 10_000) / 100,
  };
}

const admin = await shootAdmin();
say(`admin screenshots → ${out}`);
if (values.h5) {
  const h5 = await shootH5(values.h5);
  const results = BLOCKS.map((block) => diff(block, admin[block], h5[block]));
  say(JSON.stringify(results, null, 2));
  writeFileSync(resolve(out, 'fidelity.json'), `${JSON.stringify(results, null, 2)}\n`);
  const flagged = results.filter((result) => result.percent > Number(values.flag));
  say(
    flagged.length === 0
      ? `every block within ${values.flag} %`
      : `over ${values.flag} %: ${flagged.map((result) => `${result.block} ${result.percent} %`).join(', ')}`,
  );
} else {
  say('no --h5 URL: admin screenshots only, nothing to diff against');
}
