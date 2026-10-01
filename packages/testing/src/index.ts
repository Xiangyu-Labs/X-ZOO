/**
 * `@shop/testing` — the shared test harness.
 *
 * Integration tests get a real PostgreSQL 17 and Redis 7 through Testcontainers
 * (`harness/global-setup.ts`, wired up by the vitest preset in `@shop/config`),
 * a per-file cloned database, a real `Ctx`, and `runConcurrently` for the
 * concurrency test `docs/conventions.md` requires on every conditional state
 * change.
 */
export * from './harness/concurrency';
export * from './harness/ctx';
export * from './harness/db';
export * from './factories';
export * from './fakes';
export * from './wechat/fake-gateway';
export { startMockServer, matchRoute, compileRoute, pickExample } from './mock-server/index';
export type { MockServerOptions, RunningMockServer } from './mock-server/index';
