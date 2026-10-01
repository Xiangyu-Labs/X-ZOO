import type { ClientPlatform } from '@shop/contracts/conventions';
import type { Db, Tx } from '@shop/db';
import type Redis from 'ioredis';
import type { Clock } from './clock';
import type { ConfigService } from './config-registry';
import type { Logger } from './logger';
import type { JobQueue } from './queue';
import type { Storage } from './storage';
import { DomainError } from './errors';
import { withTx, type TxOptions } from './tx';

/**
 * Everything a service is allowed to reach for.
 *
 * `Ctx` is built once per request by `handle()` in `apps/web/src/server`, and
 * once per job by the worker. A service takes `(ctx, input)` and nothing else —
 * no module-level database handle, no ambient clock, no global config — which
 * is what makes the whole system testable with `createTestCtx()`.
 */

export type ActorKind = 'admin' | 'user' | 'anonymous' | 'system';

export interface Actor {
  kind: ActorKind;
  /** Admin id, user id, or `null` for `anonymous`/`system`. */
  id: number | null;
  /** Granted permission atoms. Empty for non-admin actors. */
  permissions: readonly string[];
  /** Super admins bypass every permission check. */
  isSuper: boolean;
  /** Opaque session identifier, for logging and for revocation. */
  sessionId?: string;
  /** Login name / nickname, only for the audit log. */
  display?: string;
  /** Set when an admin acts through an API token (agent, CLI) instead of the console. */
  apiTokenId?: number;
}

export const anonymousActor: Actor = Object.freeze({
  kind: 'anonymous',
  id: null,
  permissions: Object.freeze([]) as readonly string[],
  isSuper: false,
});

/** The actor a worker job or a seed runs as. Bypasses permission checks. */
export const systemActor: Actor = Object.freeze({
  kind: 'system',
  id: null,
  permissions: Object.freeze([]) as readonly string[],
  isSuper: true,
});

export interface Ctx {
  readonly db: Db;
  readonly redis: Redis;
  readonly clock: Clock;
  readonly config: ConfigService;
  readonly logger: Logger;
  readonly queue: JobQueue;
  readonly storage: Storage;
  readonly actor: Actor;
  /** From `X-Client-Platform`; `null` on the admin surface and in jobs. */
  readonly platform: ClientPlatform | null;
  /**
   * From `X-Client-Version` when it parses (`clientVersion` in the contracts);
   * absent on the admin surface, in jobs, and for a client that sent none.
   */
  readonly clientVersion?: string | undefined;
  /** Correlates every log line, audit row and job of one request. */
  readonly requestId: string;
  /** Route id from the contract, when the context came from `handle()`. */
  readonly routeId?: string;

  /** `ctx.withTx(async (tx) => …)`, the form `docs/conventions.md` spells out. */
  withTx<T>(fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  /** A child context with a different actor. Used by jobs acting for a user. */
  as(actor: Actor): Ctx;
}

export type CtxDeps = Omit<Ctx, 'withTx' | 'as'>;

/** Builds a `Ctx` from its parts and wires the two convenience methods. */
export function createCtx(deps: CtxDeps): Ctx {
  const ctx: Ctx = {
    ...deps,
    withTx: (fn, options) => withTx(deps.db, fn, options ?? {}),
    as: (actor) => createCtx({ ...deps, actor }),
  };
  return ctx;
}

/** The actor id, or 401. Use in services that need a logged-in user. */
export function requireActorId(ctx: Ctx): number {
  if (ctx.actor.id === null) throw new DomainError('UNAUTHENTICATED');
  return ctx.actor.id;
}

export function requireUserId(ctx: Ctx): number {
  if (ctx.actor.kind !== 'user') {
    throw new DomainError('UNAUTHENTICATED');
  }
  return requireActorId(ctx);
}

export function requireAdminId(ctx: Ctx): number {
  if (ctx.actor.kind !== 'admin') throw new DomainError('UNAUTHENTICATED');
  return requireActorId(ctx);
}
