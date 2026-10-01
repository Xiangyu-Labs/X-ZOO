import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * The edge, in one process.
 *
 * `docker/edge/nginx.conf` puts the `web` container at `/admin`, `/admin-api`,
 * `/api` and `/_next`, and the uploads directory as inert bytes at
 * `/uploads/`. This mirrors those, and serves the mini-program's "模拟小程序"
 * H5 build (`src/h5.ts`) as a history-mode SPA at `/`: production never
 * serves that build, but the suite needs a page on the same origin as the
 * API, as the WeChat build's requests are to its one configured origin.
 *
 * Why an edge at all, rather than pointing Playwright at `next start`: the
 * bundle and the API have to share an origin or every request is
 * cross-origin. A hundred lines of `node:http` solves it here without asking
 * the suite to run a container it would then have to build.
 *
 * What is deliberately *not* mirrored: TLS, gzip, the SSE buffering rules and
 * the cache lifetimes. None of them changes what a spec can observe, and each
 * one would be a second place to keep a production setting correct. The rules
 * that *are* here are the ones a journey can trip over — the history fallback
 * (without it every deep link 404s), same-origin `/api` (without it the app
 * cannot reach the API at all), and the dotfile / script-extension denials
 * under `/uploads/`, which a spec asserts.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** The extensions nginx refuses under `/uploads/`, verbatim from `edge/nginx.conf`. */
const UPLOAD_DENY = /\.(ph(p[3457]?|t|tml|ar)|jsp?|aspx?|cgi|pl|py|sh|so|exe|html?|xhtml|svgz?)$/i;

/** Everything `web` answers. `^~` in nginx terms: these win over the SPA. */
const PROXIED =
  /^\/(admin|admin-api|api|scan-upload|mcp|oauth|_next|\.well-known\/oauth-(protected-resource|authorization-server))(\/|$)/;

export interface EdgeOptions {
  port: number;
  /** The H5 build — `apps/mini/dist/h5-mp-emulation`. */
  root: string;
  /** Where uploads land. Served as inert bytes at `/uploads/`. */
  uploadsDir: string;
  /** `next start`'s origin. */
  upstream: string;
  /**
   * The gateway control-plane's origin
   * (`gateway-control.ts`). `/__e2e/mini/*` on the edge goes to its
   * `/mini/*`, which is how the "模拟小程序" build gets its `wx.login` and
   * `getPhoneNumber` codes and completes `requestPayment`
   * (`apps/mini/src/platform/h5-mp-emulation.tsx`). Unset, those paths are
   * an ordinary 404, as they are in production.
   */
  controlUpstream?: string | undefined;
}

/** The emulated WeChat client's harness endpoints, same-origin for the page. */
const MINI_CONTROL = /^\/__e2e\/mini\/[a-z-]+$/;

export interface RunningEdge {
  url: string;
  close(): Promise<void>;
}

export async function startEdge(options: EdgeOptions): Promise<RunningEdge> {
  const upstream = new URL(options.upstream);

  const server = http.createServer((req, res) => {
    void handle(req, res, options, upstream).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`edge: ${String(error)}`);
    });
  });

  // An SSE stream and a slow upload both outlive the default 5s keep-alive
  // timeout; a socket closed mid-response reaches the page as a network error
  // that has nothing to do with what the spec was asserting.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: EdgeOptions,
  upstream: URL,
): Promise<void> {
  const target = req.url ?? '/';
  // `decodeURIComponent` on the whole path would turn `%2e%2e` into `..` and
  // hand a traversal to `path.join`. nginx answers 400 for an encoded dot
  // segment; so does this.
  if (/%2e/i.test(target)) {
    res.writeHead(400).end();
    return;
  }
  const pathname = new URL(target, 'http://edge').pathname;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok\n');
    return;
  }

  if (PROXIED.test(pathname)) {
    await proxy(req, res, upstream);
    return;
  }

  if (options.controlUpstream && MINI_CONTROL.test(pathname)) {
    await proxy(req, res, new URL(options.controlUpstream), pathname.slice('/__e2e'.length));
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    await serveUpload(res, options.uploadsDir, pathname.slice('/uploads/'.length));
    return;
  }

  await serveStatic(res, options.root, pathname);
}

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: URL,
  pathOverride?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proxied = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: pathOverride ?? req.url,
        method: req.method,
        headers: {
          ...req.headers,
          // `handle()` compares `Origin` against `APP_ORIGIN`, and the app is
          // configured with the *edge's* origin, so the header has to survive
          // the hop unchanged. Rewriting `host` would make it disagree.
          host: upstream.host,
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        pipeline(upstreamRes, res).then(resolve, () => resolve());
      },
    );
    proxied.on('error', reject);
    pipeline(req, proxied).catch(() => proxied.destroy());
  });
}

async function serveUpload(
  res: http.ServerResponse,
  root: string,
  relative: string,
): Promise<void> {
  const name = path.basename(relative);
  if (name.startsWith('.') || UPLOAD_DENY.test(relative)) {
    res.writeHead(403).end();
    return;
  }
  const file = resolveWithin(root, relative);
  if (!file) {
    res.writeHead(403).end();
    return;
  }
  // Known media types keep their real type; everything else is bytes, not a
  // guess. An image served as `text/html` because a browser guessed is a
  // stored XSS on our own origin, which is why `nosniff` is not optional.
  await send(res, file, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'inline',
  });
}

async function serveStatic(
  res: http.ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  if (pathname.split('/').some((segment) => segment.startsWith('.') && segment !== '')) {
    res.writeHead(403).end();
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = resolveWithin(root, relative);
  if (file && (await isFile(file))) {
    await send(res, file, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', {
      'x-content-type-options': 'nosniff',
    });
    return;
  }

  // History-mode fallback, last so every rule above wins over it. An asset
  // request that falls through to `index.html` is the failure mode this
  // exists to hide, so it does not: a request that looks like a file gets a
  // 404 instead, which is what a spec watching `page.on('requestfailed')`
  // needs to see.
  if (/\.[a-z0-9]{1,8}$/i.test(relative)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }

  const index = path.join(root, 'index.html');
  await send(res, index, MIME['.html']!, {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache, must-revalidate',
  });
}

/** `null` when `relative` escapes `root`, which is the only answer a traversal gets. */
function resolveWithin(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  return resolved.startsWith(prefix) || resolved === path.resolve(root) ? resolved : null;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function send(
  res: http.ServerResponse,
  file: string,
  contentType: string,
  headers: Record<string, string>,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': contentType, 'content-length': String(size) });
  await pipeline(createReadStream(file), res).catch(() => {});
}
