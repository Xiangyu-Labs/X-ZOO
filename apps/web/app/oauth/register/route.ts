import { oauth } from '@shop/core/auth';
import { getContainer } from '../../../src/server/container';
import { oauthError, oauthJson, preflight, withinBudget } from '../../../src/server/oauth-http';

/**
 * Dynamic client registration (RFC 7591). An MCP client calls this once,
 * before sending the admin to `/oauth/authorize`. Registering grants nothing:
 * a client id is only a name and a list of allowed redirect URIs.
 */
export async function POST(request: Request): Promise<Response> {
  const container = getContainer();
  if (!(await withinBudget(container, request, 'register', 20, 60 * 60 * 1000))) {
    return oauthError(429, 'too_many_requests', '注册过于频繁，请稍后再试');
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError(400, 'invalid_client_metadata', 'body must be JSON');
  }
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
    : [];
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') {
    return oauthError(
      400,
      'invalid_client_metadata',
      'only public clients (token_endpoint_auth_method "none")',
    );
  }
  const result = await oauth.registerClient(container, {
    clientName: typeof metadata.client_name === 'string' ? metadata.client_name : '',
    redirectUris,
  });
  if (!result.ok) return oauthError(400, result.error, result.description);
  return oauthJson(201, {
    client_id: result.value.clientId,
    client_id_issued_at: Math.floor(container.clock.nowMs() / 1000),
    client_name: result.value.clientName,
    redirect_uris: result.value.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

export const OPTIONS = preflight;

export const dynamic = 'force-dynamic';
