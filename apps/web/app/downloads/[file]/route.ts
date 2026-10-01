import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * `/downloads/shop.js` — the `shop` CLI, built from this same commit
 * (`docker/web.Dockerfile` puts it at `apps/web/cli/shop.js`). Serving it from
 * the shop is what keeps the CLI's bundled operation list matching the routes
 * it will call; `x-shop-cli-sha256` lets a downloaded copy tell it is stale
 * (`apps/cli/src/freshness.ts`).
 *
 * Public: it holds the contracts, which the repository already publishes, and
 * no secret. In development it falls back to `pnpm --filter @shop/cli build`'s
 * output.
 *
 * A `[file]` segment rather than a `shop.js/` folder: a folder named `*.js`
 * falls under the lint config's ignore of JS tooling files.
 */

const CANDIDATES = [
  path.join(process.cwd(), 'cli', 'shop.js'),
  path.join(process.cwd(), '..', 'cli', 'dist', 'shop.js'),
];

let cached: Promise<{ bytes: Buffer; sha256: string } | null> | null = null;

async function load(): Promise<{ bytes: Buffer; sha256: string } | null> {
  for (const file of CANDIDATES) {
    try {
      const bytes = await readFile(file);
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      // try the next place
    }
  }
  return null;
}

async function serve(
  request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  if ((await params).file !== 'shop.js') return new Response(null, { status: 404 });
  // The image's file never changes; in development a rebuild should show.
  const built = await (process.env.NODE_ENV === 'production' ? (cached ??= load()) : load());
  if (!built) {
    return new Response('shop.js 还没有构建：pnpm --filter @shop/cli build\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(built.bytes), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(built.bytes.length),
      'content-disposition': 'attachment; filename="shop.js"',
      'cache-control': 'no-cache',
      'x-shop-cli-sha256': built.sha256,
    },
  });
}

export const GET = serve;
export const HEAD = serve;

export const dynamic = 'force-dynamic';
