import type { oauth } from '@shop/core/auth';

/**
 * The authorization request as `/oauth/authorize` and its decision post carry
 * it. `state` is the client's own value and is echoed back untouched.
 */
export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
}

const KEYS: readonly (keyof AuthorizeParams)[] = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
];

export function authorizeParams(
  source: Record<string, string | string[] | undefined> | URLSearchParams,
): AuthorizeParams {
  const read = (key: string): string => {
    const value = source instanceof URLSearchParams ? source.get(key) : source[key];
    return typeof value === 'string' ? value.slice(0, 2048) : '';
  };
  return Object.fromEntries(KEYS.map((key) => [key, read(key)])) as unknown as AuthorizeParams;
}

export function asAuthorizeRequest(params: AuthorizeParams): oauth.AuthorizeRequest {
  return {
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    responseType: params.response_type,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
  };
}

/** Only for a redirect URI already matched against the client's registration. */
export function errorRedirect(params: AuthorizeParams, error: string, description: string): string {
  const url = new URL(params.redirect_uri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (params.state) url.searchParams.set('state', params.state);
  return url.toString();
}
