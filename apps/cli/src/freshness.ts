import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Whether this `shop.js` is the one the shop serves today.
 *
 * The operation list is bundled in at build time, so a copy downloaded before
 * an upgrade knows yesterday's routes. The shop serves its own build at
 * `/downloads/shop.js` with the file's SHA-256 in `x-shop-cli-sha256`; a
 * differing hash is a one-line hint on stderr, never a failure. Skipped when
 * run from source (`pnpm dev`), and silent when the shop cannot say.
 */

declare const __SHOP_CLI_BUNDLE__: boolean | undefined;

export const DOWNLOAD_PATH = '/downloads/shop.js';

export async function checkFreshness(origin: string): Promise<string | null> {
  if (typeof __SHOP_CLI_BUNDLE__ === 'undefined') return null;
  try {
    const [mine, response] = await Promise.all([
      readFile(fileURLToPath(import.meta.url)).then((bytes) =>
        createHash('sha256').update(bytes).digest('hex'),
      ),
      fetch(`${origin}${DOWNLOAD_PATH}`, { method: 'HEAD', signal: AbortSignal.timeout(3_000) }),
    ]);
    const theirs = response.ok ? response.headers.get('x-shop-cli-sha256') : null;
    if (!theirs || theirs === mine) return null;
    return `提示：商城已更新，这个 shop.js 是旧版本，操作列表可能过时。重新下载：curl -o shop.js ${origin}${DOWNLOAD_PATH}`;
  } catch {
    return null;
  }
}
