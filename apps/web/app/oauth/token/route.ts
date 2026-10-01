import { oauth, refreshOAuthGrant, type OAuthTokenSet } from '@shop/core/auth';
import { getContainer } from '../../../src/server/container';
import {
  oauthError,
  oauthJson,
  preflight,
  readParams,
  withinBudget,
} from '../../../src/server/oauth-http';

/**
 * The token endpoint: redeems an authorization code (PKCE-checked) or rotates
 * a refresh token. Public clients — no client secret, the `client_id` is
 * matched against the grant.
 */
function tokenResponse(tokens: OAuthTokenSet): Response {
  return oauthJson(200, {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresInSeconds,
    refresh_token: tokens.refreshToken,
    scope: 'shop',
  });
}

export async function POST(request: Request): Promise<Response> {
  const container = getContainer();
  if (!(await withinBudget(container, request, 'token', 120, 60 * 60 * 1000))) {
    return oauthError(429, 'too_many_requests', '请求过于频繁，请稍后再试');
  }
  const params = await readParams(request);
  const clientId = params.client_id ?? '';
  if (!clientId) return oauthError(400, 'invalid_client', 'client_id required');

  if (params.grant_type === 'authorization_code') {
    const result = await oauth.redeemAuthorizationCode(container, {
      code: params.code ?? '',
      clientId,
      redirectUri: params.redirect_uri ?? '',
      codeVerifier: params.code_verifier ?? '',
    });
    return result.ok
      ? tokenResponse(result.value)
      : oauthError(400, result.error, result.description);
  }

  if (params.grant_type === 'refresh_token') {
    const tokens = await refreshOAuthGrant(container, {
      refreshToken: params.refresh_token ?? '',
      clientId,
    });
    return tokens
      ? tokenResponse(tokens)
      : oauthError(400, 'invalid_grant', '登录已失效，请重新授权');
  }

  return oauthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
}

export const OPTIONS = preflight;

export const dynamic = 'force-dynamic';
