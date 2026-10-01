import { getContainer } from '../../../../src/server/container';
import { oauthJson, preflight, publicOrigin } from '../../../../src/server/oauth-http';

/**
 * Authorization-server metadata (RFC 8414), served at
 * `/.well-known/oauth-authorization-server` through a rewrite. Only what
 * `core/auth/oauth.service.ts` implements: public clients, code + PKCE S256,
 * refresh tokens, dynamic registration.
 */
export function GET(): Response {
  const origin = publicOrigin(getContainer());
  return oauthJson(200, {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['shop'],
  });
}

export const OPTIONS = preflight;

export const dynamic = 'force-dynamic';
