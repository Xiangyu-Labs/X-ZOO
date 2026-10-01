import { getContainer } from '../../src/server/container';
import { createShopMcpEndpoint } from '../../src/server/mcp';
import { preflight, withCors } from '../../src/server/oauth-http';

/**
 * `/mcp` — the shop's remote MCP server (Streamable HTTP, stateless).
 * See `src/server/mcp.ts`.
 *
 * `call_operation` loops back to this server's own `/admin-api/**` on
 * loopback, so it never leaves the container and never meets the edge.
 */
const endpoint = createShopMcpEndpoint(getContainer, {
  internalOrigin: `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
});

async function serve(request: Request): Promise<Response> {
  return withCors(await endpoint(request));
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
export const OPTIONS = preflight;

export const dynamic = 'force-dynamic';
