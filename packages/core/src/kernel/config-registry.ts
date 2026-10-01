import type { DbOrTx } from '@shop/db';
import type { z } from 'zod';
import { deleteValues, loadGroup, upsertValues } from './config.repo';
import { DomainError } from './errors';
import type { Clock } from './clock';
import { withTx } from './tx';

/**
 * Typed configuration.
 *
 * There is no key-value settings blob. A domain declares one group — a zod
 * schema plus the metadata a form needs — in `core/src/<domain>/<group>.config.ts`;
 * values live in `config_values(group, key, value jsonb)`; one
 * `<ConfigGroupForm>` renders every config page.
 *
 * Two rules make this work:
 *  1. **Every field has a `.default()`.** A group must be readable before
 *     anybody has ever saved it, otherwise a fresh install cannot boot.
 *  2. **Reads go through `config.get(group)`, never by key**, so a typo is a
 *     type error rather than a silent `undefined`.
 */

export type ConfigFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'switch'
  | 'select'
  | 'multi-select'
  | 'image'
  | 'images'
  | 'file'
  | 'password'
  | 'json'
  | 'color'
  | 'richtext'
  | 'url';

/**
 * What a `number` field counts. The form shows it as a suffix, and `bytes`
 * is edited in MB and stored in bytes, so nobody types 10485760.
 */
export type ConfigFieldUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'ms' | 'bytes' | 'items';

/** Where a group sits on the settings index. */
export type ConfigGroupCategory = 'basic' | 'wechat' | 'trade' | 'integration' | 'rules';

/**
 * Data-only conditional visibility: render the field when `values[key]` matches.
 *
 * Only the data form exists on purpose — a predicate function cannot be
 * serialised into the descriptor the browser receives, and the admin kit's
 * `<ConfigGroupForm>` accepts exactly this shape.
 */
export interface ConfigVisibleWhen {
  key: string;
  /** A single value, or any of a list. */
  equals: unknown;
}

export interface ConfigFieldUi {
  label: string;
  type: ConfigFieldType;
  help?: string;
  placeholder?: string;
  options?: ReadonlyArray<{ label: string; value: string | number | boolean }>;
  /** Tab/section inside the group's form. */
  section?: string;
  /**
   * Render only when another field **of the same group** matches. The key is
   * checked against the group's schema at declaration time.
   *
   * A hidden field is not part of the saved payload and its required-ness is
   * not enforced in the browser, so the stored value survives untouched: a shop
   * on the `local` storage driver never has to fill in an S3 bucket to change
   * an upload limit.
   */
  visibleWhen?: ConfigVisibleWhen;
  /** Rendered write-only: the current value is never sent to the browser. */
  secret?: boolean;
  /**
   * Shown, but not an operator's to change.
   *
   * Some settings are facts about the deployment rather than decisions about
   * the shop — `site.publicOrigin` is the example. An origin typed into a
   * settings screen goes stale the day the shop moves domains, and every
   * WeChat link then carries the old one until somebody notices. The value
   * comes from the environment, and a field that shows the *current* one while
   * refusing to save it is honest: leaving it off the screen entirely just
   * makes an operator hunt for where the wrong value is coming from.
   *
   * The screen renders it as plain text with no control, `configSave` refuses
   * the key with `CONFIG_FIELD_READ_ONLY`, and the two are independent — the
   * second is what holds for a stale tab or a hand-made request.
   */
  readOnly?: boolean;
  /**
   * Where a `readOnly` value comes from, e.g. `env:PUBLIC_ORIGIN`. Shown as
   * help text, because "you cannot edit this" without "and here is what to
   * edit instead" is an unanswerable screen.
   */
  source?: string;
  /** Display order inside the section; ties fall back to declaration order. */
  order?: number;
  /** `number` only. */
  unit?: ConfigFieldUnit;
}

export interface ConfigGroupDef<S extends z.ZodObject = z.ZodObject> {
  /** Stable group name; also the `config_values.group` value. Domain-named. */
  group: string;
  title: string;
  /** One line under the title, on the index card and the screen. */
  description?: string;
  /** Which block of the settings index the group is listed under. Default `rules`. */
  category?: ConfigGroupCategory;
  schema: S;
  ui: Partial<Record<keyof z.infer<S> & string, ConfigFieldUi>>;
  /** Permission atom required to read/write this group in the admin UI. */
  permission?: string;
  /**
   * The state of the saved values in a few words, for the index card: which
   * provider is in use, 「未启用」, or what is still missing. Reads nothing
   * but the group's own values.
   */
  status?: (config: z.infer<S>) => ConfigGroupStatus;
}

/**
 * `on`: in use. `off`: switched off on purpose. `incomplete`: switched on,
 * but something it needs is blank, so it cannot work.
 */
export interface ConfigGroupStatus {
  tone: 'on' | 'off' | 'incomplete';
  text: string;
}

const registry = new Map<string, ConfigGroupDef>();

/**
 * Declares a config group and registers it. Registration is a side effect of
 * the module being imported, which is exactly how the `pnpm gen` config bucket
 * works: importing every `*.config.ts` file fills this map, so no shared index
 * has to be edited when a domain adds a group.
 */
export function defineConfigGroup<S extends z.ZodObject>(
  def: ConfigGroupDef<S>,
): ConfigGroupDef<S> {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(def.group)) {
    throw new Error(`config group "${def.group}" 必须是小写短横线命名`);
  }
  const existing = registry.get(def.group);
  if (existing && existing !== (def as unknown as ConfigGroupDef)) {
    throw new Error(`config group "${def.group}" 重复定义`);
  }
  // A group must be readable with nothing stored, or a fresh install cannot boot.
  const probe = def.schema.safeParse({});
  if (!probe.success) {
    const missing = probe.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`config group "${def.group}": 每个字段都必须有 .default()（缺少：${missing}）`);
  }
  // `visibleWhen` may only point at a field of the same group: a typo here
  // hides the field for ever with no error anywhere, which is the failure mode
  // the whole registry exists to avoid.
  const known = new Set(Object.keys(def.schema.shape));
  for (const [key, ui] of Object.entries(def.ui as Record<string, ConfigFieldUi | undefined>)) {
    const dependency = ui?.visibleWhen?.key;
    if (dependency === undefined) continue;
    if (!known.has(dependency)) {
      throw new Error(
        `config group "${def.group}": 字段 "${key}" 的 visibleWhen.key "${dependency}" 不是本分组的字段`,
      );
    }
    if (dependency === key) {
      throw new Error(`config group "${def.group}": 字段 "${key}" 的 visibleWhen 不能指向自己`);
    }
  }
  registry.set(def.group, def as unknown as ConfigGroupDef);
  return def;
}

export function getConfigGroup(group: string): ConfigGroupDef | undefined {
  return registry.get(group);
}

export function allConfigGroups(): ConfigGroupDef[] {
  return [...registry.values()].sort((a, b) => a.group.localeCompare(b.group));
}

/** Test helper: forget every registration. Never call this from app code. */
export function resetConfigRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ConfigService {
  /**
   * Typed read. Pass the group definition the domain exported.
   *
   * On a cache miss this reads from the **pool**. Never call it while a
   * transaction is open on the same request: use `getIn(tx, group)` there.
   */
  get<S extends z.ZodObject>(group: ConfigGroupDef<S>): Promise<z.infer<S>>;
  /**
   * The same typed read, for code that is inside a transaction.
   *
   * A cache hit is the same as `get`. On a miss the rows are read through the
   * caller's `tx`, never through a second pooled connection. A transaction
   * that holds a row lock and then waits for a pool connection deadlocks the
   * pool as soon as `max` transactions queue on that lock: every connection is
   * held by a waiter, and the holder waits for one of them. That is how the
   * stock reservation wedged the web pool (`catalog.stock.pool.int.test.ts`).
   *
   * A miss does **not** fill the cache: the rows were read inside somebody
   * else's transaction, which may have written them and may still roll back.
   * The next `get` fills it from committed rows. The cost is one indexed read
   * per call while the cache is cold.
   *
   * Handed the pool rather than a transaction (a `db: DbOrTx` helper called
   * from both a read path and a write path), it is exactly `get`.
   *
   * `pnpm guards tx-pool` flags `ctx.config.get(`, `ctx.db` and `ctx.withTx(`
   * inside any function that takes a `tx`, a `Tx` or a `DbOrTx`.
   */
  getIn<S extends z.ZodObject>(db: DbOrTx, group: ConfigGroupDef<S>): Promise<z.infer<S>>;
  /** Untyped read by name, for the generic admin config screen. */
  getRaw(group: string): Promise<Record<string, unknown>>;
  /**
   * Validates the *whole* group after merging the patch, writes only the keys
   * that changed, and drops the cache. Returns the new effective values.
   */
  set<S extends z.ZodObject>(
    group: ConfigGroupDef<S>,
    patch: Partial<z.infer<S>>,
    options?: { updatedBy?: number | null },
  ): Promise<z.infer<S>>;
  invalidate(group: string): Promise<void>;
}

/** Just enough of ioredis for this module; keeps the fake honest. */
export interface ConfigCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  publish?(channel: string, message: string): Promise<unknown>;
}

export interface ConfigServiceOptions {
  db: DbOrTx;
  cache: ConfigCache;
  clock: Clock;
  /** Cache lifetime. The cache is also dropped explicitly on every write. */
  ttlMs?: number;
  keyPrefix?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** `rollback()` exists only on a drizzle transaction (the same test `withTx` uses). */
function isTransaction(handle: DbOrTx): boolean {
  return typeof (handle as { rollback?: unknown }).rollback === 'function';
}

export function createConfigService(options: ConfigServiceOptions): ConfigService {
  const { db, cache, clock, ttlMs = DEFAULT_TTL_MS, keyPrefix = 'config:' } = options;
  const cacheKey = (group: string) => `${keyPrefix}${group}`;

  async function readCached(key: string): Promise<Record<string, unknown> | null> {
    const cached = await cache.get(key);
    if (cached === null) return null;
    try {
      return JSON.parse(cached) as Record<string, unknown>;
    } catch {
      // A corrupt cache entry must never take the shop down.
      await cache.del(key);
      return null;
    }
  }

  async function loadRaw(source: DbOrTx, group: string): Promise<Record<string, unknown>> {
    const rows = await loadGroup(source, group);
    const raw: Record<string, unknown> = {};
    for (const row of rows) raw[row.key] = row.value;
    return raw;
  }

  async function readRaw(group: string): Promise<Record<string, unknown>> {
    const key = cacheKey(group);
    const cached = await readCached(key);
    if (cached !== null) return cached;
    const raw = await loadRaw(db, group);
    await cache.set(key, JSON.stringify(raw), 'PX', ttlMs);
    return raw;
  }

  /** Stored data that no longer matches the schema falls back to defaults field by field. */
  function typed<S extends z.ZodObject>(
    group: ConfigGroupDef<S>,
    raw: Record<string, unknown>,
  ): z.infer<S> {
    const parsed = group.schema.safeParse(raw);
    if (parsed.success) return parsed.data as never;
    // Rather than failing every request in the shop, drop the broken fields.
    const repaired: Record<string, unknown> = { ...raw };
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      if (typeof head === 'string') delete repaired[head];
    }
    return group.schema.parse(repaired) as never;
  }

  return {
    async get(group) {
      return typed(group, await readRaw(group.group));
    },

    async getIn(handle, group) {
      if (!isTransaction(handle)) return typed(group, await readRaw(group.group));
      const cached = await readCached(cacheKey(group.group));
      return typed(group, cached ?? (await loadRaw(handle, group.group)));
    },

    async getRaw(group) {
      return readRaw(group);
    },

    async set(group, patch, setOptions = {}) {
      const current = await readRaw(group.group);
      const merged = { ...current, ...patch };
      const parsed = group.schema.safeParse(merged);
      if (!parsed.success) {
        throw new DomainError('VALIDATION_FAILED', {
          details: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        });
      }
      const effective = parsed.data as Record<string, unknown>;
      const changed = Object.keys(patch).filter(
        (key) => JSON.stringify(current[key]) !== JSON.stringify(effective[key]),
      );
      if (changed.length > 0) {
        const now = clock.now();
        await withTx(db, async (tx) => {
          await upsertValues(
            tx,
            group.group,
            changed.map((key) => ({ key, value: effective[key] ?? null })),
            { updatedBy: setOptions.updatedBy ?? null, now },
          );
        });
      }
      // Invalidate *after* the commit: a reader that raced the write refills
      // from the committed rows, never from the uncommitted ones.
      await cache.del(cacheKey(group.group));
      await cache.publish?.(`${keyPrefix}invalidate`, group.group);
      return effective as never;
    },

    async invalidate(group) {
      await cache.del(cacheKey(group));
      await cache.publish?.(`${keyPrefix}invalidate`, group);
    },
  };
}

/** Removes stored keys the schema no longer knows about, e.g. after a field is dropped. */
export async function pruneUnknownKeys(db: DbOrTx, group: ConfigGroupDef): Promise<string[]> {
  const known = new Set(Object.keys(group.schema.shape));
  const rows = await loadGroup(db, group.group);
  const unknown = rows.map((r) => r.key).filter((key) => !known.has(key));
  await deleteValues(db, group.group, unknown);
  return unknown;
}

/** An in-memory `ConfigCache` for unit tests. */
export function memoryConfigCache(): ConfigCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys) if (store.delete(key)) n += 1;
      return n;
    },
  };
}
