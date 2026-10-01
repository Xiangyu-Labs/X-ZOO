import { getContainer } from '../../../../src/server/container';
import { oauthJson, preflight, publicOrigin } from '../../../../src/server/oauth-http';

/**
 * Protected-resource metadata (RFC 9728) for `/mcp`, served at
 * `/.well-known/oauth-protected-resource[/mcp]` through a rewrite in
 * `next.config.ts`. Tells an MCP client which authorization server to use.
 */
export function GET(): Response {
  const origin = publicOrigin(getContainer());
  return oauthJson(200, {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['shop'],
    resource_name: '商城后台',
  });
}

export const OPTIONS = preflight;

export const dynamic = 'force-dynamic';
