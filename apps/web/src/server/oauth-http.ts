import { fixedWindow } from '@shop/core/kernel';
import type { Container } from './container';
import { clientIp } from './request-meta';

/**
 * HTTP plumbing shared by `/oauth/*` and `/mcp`: the OAuth endpoints speak
 * RFC 6749 JSON (`{ error, error_description }`), not the admin API's
 * envelope, because the clients on the other end are generic OAuth clients.
 *
 * CORS is open (`*`) on these endpoints and on `/mcp`: they authenticate with
 * a bearer token or a PKCE-bound code, never a cookie, so another origin
 * gains nothing it could not do from a server. Browser-based MCP clients (the
 * MCP Inspector) need it.
 */

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '600',
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function oauthJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

export function oauthError(status: number, error: string, description: string): Response {
  return oauthJson(status, { error, error_description: description });
}

/** `application/x-www-form-urlencoded` (what RFC 6749 says) or JSON (what some clients send). */
export async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      }
    } catch {
      return {};
    }
    return {};
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * The public origin, from `APP_ORIGIN`: issuer, endpoint URLs and the MCP
 * resource identifier must be the URL clients use, not the loopback address
 * the request may have arrived on.
 */
export function publicOrigin(container: Container): string {
  return container.env.APP_ORIGIN.replace(/\/+$/, '');
}

/** Per-address budget for the unauthenticated endpoints (registration, token). */
export async function withinBudget(
  container: Container,
  request: Request,
  name: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const result = await fixedWindow(container.redis, {
    key: `oauth:rl:${name}:${clientIp(request) ?? 'unknown'}`,
    limit,
    windowMs,
    nowMs: container.clock.nowMs(),
  });
  return result.allowed;
}
