import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { DbOrTx } from '@shop/db';
import type { Clock } from '../kernel/clock';
import { randomToken } from '../kernel/ids';
import * as tokenRepo from './api-token.repo';
import { issueOAuthGrant, type OAuthTokenSet } from './api-token.service';
import { sha256Hex } from './password';

/**
 * The OAuth 2.1 authorization server behind `/mcp`, cut to what the MCP
 * authorization spec asks of one and nothing more:
 *
 * - dynamic client registration (RFC 7591) — public clients, no secret;
 * - the authorization-code grant with PKCE `S256`, mandatory;
 * - `refresh_token` with rotation (`api-token.service.ts`).
 *
 * The "user" who signs in is an admin, through the ordinary console login;
 * `/oauth/authorize` only adds the consent screen. What the client ends up
 * with is an `oauth` row in `admin_api_tokens` acting as that admin.
 *
 * This is how Claude, ChatGPT and any other spec-following MCP client connect.
 * A client that cannot do OAuth uses a personal token in a header instead.
 */

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
}

export type OAuthResult<T> =
  { ok: true; value: T } | { ok: false; error: string; description: string };

const CODE_TTL_MS = 60_000;
const codeKey = (code: string) => `oauth:code:${sha256Hex(code)}`;

/**
 * `https://` anywhere, `http://` only on loopback (a desktop client's local
 * callback), and custom schemes such as `cursor://` for desktop apps. Never a
 * fragment, as RFC 6749 §3.1.2 requires.
 */
export function isAcceptableRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }
  // A private-use scheme (`cursor:`, `vscode:`); `javascript:`, `data:` and friends are not that.
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
    !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol)
  );
}

export async function registerClient(
  deps: { db: DbOrTx; clock: Clock },
  input: RegisterClientInput,
): Promise<OAuthResult<{ clientId: string; clientName: string; redirectUris: string[] }>> {
  const redirectUris = [...new Set(input.redirectUris)];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect_uris: 1 to 10 required',
    };
  }
  const bad = redirectUris.find((uri) => uri.length > 512 || !isAcceptableRedirectUri(uri));
  if (bad) return { ok: false, error: 'invalid_redirect_uri', description: `not allowed: ${bad}` };
  const clientName = (input.clientName.trim() || 'MCP 客户端').slice(0, 128);
  const clientId = `mcp_${randomToken(24)}`;
  await tokenRepo.insertClient(deps.db, {
    clientId,
    name: clientName,
    redirectUris,
    now: deps.clock.now(),
  });
  return { ok: true, value: { clientId, clientName, redirectUris } };
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
}

/**
 * Checks an `/oauth/authorize` request before anybody is asked to consent.
 * `redirectTrusted: false` means the error must be shown on our own page, not
 * sent to a redirect URI we cannot vouch for.
 */
export async function validateAuthorizeRequest(
  db: DbOrTx,
  input: AuthorizeRequest,
): Promise<
  | { ok: true; clientName: string }
  | { ok: false; redirectTrusted: boolean; error: string; description: string }
> {
  const client = await tokenRepo.findClient(db, input.clientId);
  if (!client) {
    return {
      ok: false,
      redirectTrusted: false,
      error: 'invalid_client',
      description: '未知的客户端',
    };
  }
  if (!client.redirectUris.includes(input.redirectUri)) {
    return {
      ok: false,
      redirectTrusted: false,
      error: 'invalid_request',
      description: '回调地址未登记',
    };
  }
  if (input.responseType !== 'code') {
    return {
      ok: false,
      redirectTrusted: true,
      error: 'unsupported_response_type',
      description: 'code only',
    };
  }
  if (
    input.codeChallengeMethod !== 'S256' ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)
  ) {
    return {
      ok: false,
      redirectTrusted: true,
      error: 'invalid_request',
      description: 'PKCE S256 required',
    };
  }
  return { ok: true, clientName: client.name };
}

/** Consent given: a one-time code, redeemable within a minute by the same client. */
export async function createAuthorizationCode(
  redis: Redis,
  input: { adminId: number; clientId: string; redirectUri: string; codeChallenge: string },
): Promise<string> {
  const code = randomToken(40);
  await redis.set(codeKey(code), JSON.stringify(input), 'PX', CODE_TTL_MS);
  return code;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** `grant_type=authorization_code`. The code is spent whether or not the rest checks out. */
export async function redeemAuthorizationCode(
  deps: { db: DbOrTx; clock: Clock; redis: Redis },
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
): Promise<OAuthResult<OAuthTokenSet>> {
  const key = codeKey(input.code);
  const [[, raw]] = ((await deps.redis.multi().get(key).del(key).exec()) ?? [[null, null]]) as [
    [unknown, string | null],
  ];
  const invalid = { ok: false as const, error: 'invalid_grant', description: '授权码无效或已过期' };
  if (!raw) return invalid;
  const stored = JSON.parse(raw) as {
    adminId: number;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
  };
  if (stored.clientId !== input.clientId || stored.redirectUri !== input.redirectUri)
    return invalid;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) return invalid;
  if (s256(input.codeVerifier) !== stored.codeChallenge) return invalid;
  const client = await tokenRepo.findClient(deps.db, stored.clientId);
  if (!client) return invalid;
  const tokens = await issueOAuthGrant(deps, {
    adminId: stored.adminId,
    clientId: client.clientId,
    clientName: client.name,
  });
  return { ok: true, value: tokens };
}
