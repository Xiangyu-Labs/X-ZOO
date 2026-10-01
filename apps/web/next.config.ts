import type { NextConfig } from 'next';

/**
 * How many workers `next build` may start. Next sizes its pool from
 * `os.cpus()`, which on a many-core box under a memory cap gets the build
 * OOM-killed. `NEXT_BUILD_CPUS` overrides; anything that is
 * not a positive integer means the small default.
 */
function buildCpus(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/**
 * The admin UI and both API surfaces ship as one standalone Next server.
 * `@shop/contracts` is published as TypeScript source (see its package.json
 * `exports`), so it has to be transpiled by Next rather than consumed as JS.
 * So are `@shop/storefront-blocks`' `./schema` and `./fixtures` entries; its
 * `./admin` entry is prebuilt JS (blocks through the DOM shim, px → vw CSS).
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@shop/contracts', '@shop/storefront-blocks', '@shop/admin-ops'],
  // OAuth discovery for MCP clients (RFC 9728 / RFC 8414) lives at fixed
  // `/.well-known/` URLs; the handlers live under `/oauth/`.
  //
  // `fallback` runs only when no page or route matched: an API URL nothing
  // serves gets the JSON error envelope (`app/api-not-found`), not the HTML
  // 404 page.
  // Admin notifications delivered before NOTIF-008 link to pages that never
  // existed; the inbox still holds them, so send them where the record is.
  async redirects() {
    return [
      {
        source: '/admin/refunds/:id',
        destination: '/admin/trade/refunds?detail=:id',
        permanent: false,
      },
      {
        source: '/admin/payment-exceptions/:id',
        destination: '/admin/trade/payment-exceptions?detail=:id',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: '/.well-known/oauth-protected-resource/:path*',
          destination: '/oauth/metadata/resource',
        },
        {
          source: '/.well-known/oauth-protected-resource',
          destination: '/oauth/metadata/resource',
        },
        {
          source: '/.well-known/oauth-authorization-server/:path*',
          destination: '/oauth/metadata/server',
        },
        {
          source: '/.well-known/oauth-authorization-server',
          destination: '/oauth/metadata/server',
        },
      ],
      fallback: [
        { source: '/api/v1/:path*', destination: '/api-not-found' },
        { source: '/admin-api/:path*', destination: '/api-not-found' },
      ],
    };
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // The workspace root is the repository root, not `apps/web`; tell Next so the standalone
  // trace picks up the pnpm virtual store correctly.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // `next dev` otherwise writes AGENTS.md / CLAUDE.md into this package, and an
  // unexpected CLAUDE.md inside a worktree would compete with the repo's own.
  agentRules: false,
  typescript: {
    // `pnpm --filter @shop/web typecheck` is the gate; don't pay for it twice.
    ignoreBuildErrors: true,
  },
  experimental: {
    optimizePackageImports: ['antd', '@ant-design/icons'],
    cpus: buildCpus(process.env.NEXT_BUILD_CPUS),
  },
};

export default nextConfig;
