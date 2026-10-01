import type { ApiError } from './errors';

/**
 * The login page, with a way back to `next` and, when the session ran out
 * rather than never existed, `expired=1` so the page says 登录已过期.
 */
export function loginUrl(next?: string, options: { expired?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (next) params.set('next', next);
  if (options.expired) params.set('expired', '1');
  const query = params.toString();
  return query ? `/admin/login?${query}` : '/admin/login';
}

/** A 401 for a session that existed and ran out (idle, or revoked). */
export function isSessionExpiry(error: Pick<ApiError, 'status' | 'code'> | undefined): boolean {
  return error?.status === 401 && error.code === 'AUTH_SESSION_EXPIRED';
}

/** Where the admin UI sends its requests and how it reacts to a lost session. */
export interface ApiConfig {
  /** Prefixed in front of `route.path`. Empty means "same origin", which is the norm. */
  baseUrl: string;
  /** Injectable for tests and for the kit demo's in-memory mock. */
  fetch: typeof fetch;
  /**
   * Called when a request comes back 401 and the caller did not opt out.
   * Default: full page navigation to `/admin/login?next=<current url>`, with
   * `expired=1` when the error says the session ran out.
   */
  onUnauthenticated: (error?: ApiError) => void;
  /**
   * Validate 2xx bodies against `route.response`. On in development so drift
   * between a contract and its handler surfaces immediately; off in production
   * because it is pure cost on a shape the server already validated.
   */
  validateResponses: boolean;
}

function defaultOnUnauthenticated(error?: ApiError): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  if (pathname.startsWith('/admin/login')) return;
  const next = `${pathname}${search}${hash}`;
  // A hard navigation on purpose: the session is gone, so every cached query,
  // provider and in-flight request should go with it.
  window.location.assign(loginUrl(next, { expired: isSessionExpiry(error) }));
}

const config: ApiConfig = {
  baseUrl: '',
  fetch: (...args) => globalThis.fetch(...args),
  onUnauthenticated: defaultOnUnauthenticated,
  validateResponses: process.env.NODE_ENV === 'development',
};

export function getApiConfig(): Readonly<ApiConfig> {
  return config;
}

/**
 * Overrides parts of the client configuration. Used by tests, by the kit demo
 * page (to point `fetch` at an in-memory router) and, if it ever becomes
 * necessary, by a deployment that serves the API from another origin.
 */
export function configureApi(patch: Partial<ApiConfig>): void {
  Object.assign(config, patch);
}

/** Restores the shipping defaults. Test helper. */
export function resetApiConfig(): void {
  config.baseUrl = '';
  config.fetch = (...args) => globalThis.fetch(...args);
  config.onUnauthenticated = defaultOnUnauthenticated;
  config.validateResponses = process.env.NODE_ENV === 'development';
}
