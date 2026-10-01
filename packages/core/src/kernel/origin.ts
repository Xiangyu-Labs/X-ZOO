/**
 * The public origin as the environment states it.
 *
 * `PUBLIC_ORIGIN` is the explicit name; `APP_ORIGIN` is the one
 * `apps/web/src/server/env.ts` already requires of every deployment for the
 * CSRF `Origin` check, and it means exactly the same thing — the origin the
 * storefront is served from. Honouring both means a deployment needs no second
 * variable, and one that wants to be explicit can be.
 *
 * Read on every call, not captured at import: the worker and the web app both
 * boot from the same environment, and a value read once at module scope would
 * be pinned by whichever process first imported this file in a test.
 *
 * `system/site.config.ts` publishes it as `site.publicOrigin`. A domain that
 * `system` imports (`storage`) cannot read that group, so it reads this.
 */
export function originFromEnv(): string {
  return trimOrigin(process.env['PUBLIC_ORIGIN'] ?? process.env['APP_ORIGIN'] ?? '');
}

/** No trailing slash, ever: every caller concatenates a path onto this. */
export function trimOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
