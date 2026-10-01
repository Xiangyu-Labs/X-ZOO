import type { z } from 'zod';

import { BASE_PROP_KEYS } from './base';
import type { DocumentKind } from './constants';
import type { DataNeed, PersonalNeed } from './sources';

/**
 * The block registry (plan §2.1).
 *
 * A block type is declared once, here in the contracts, with `defineBlock`:
 * its prop schema (which the editor turns into a form, see `meta.ts`), its
 * version, how older versions migrate, which pages may hold it and which data
 * it asks the server for. The server validates and resolves from the same
 * declaration; the storefront renders from its inferred types.
 *
 * **Versions.** `v` is the block's own schema version, a small integer. A
 * breaking change to a block's props bumps `v` and adds `migrate[v - 1]`,
 * a pure function from the old props to the new. Stored documents are never
 * rewritten in place: they are migrated when read (validation, resolution),
 * and saved at the current version the next time the operator saves.
 *
 * **Unknown blocks.** A document may hold a type this build does not know (an
 * editor newer than the server during a deploy, a type since removed) or a
 * version newer than this build's. Readers never fail on it: validation reports
 * it, the resolver skips it, a client that meets one renders nothing for it.
 */

/** What the editor's palette and the validator need to know about a block type. */
export interface BlockMeta {
  /** Palette label, Simplified Chinese. */
  label: string;
  description?: string | undefined;
  /** The document kinds that may hold this block. */
  pages: readonly DocumentKind[];
  /** At most this many on one page (a 用户卡片 makes sense once). */
  maxPerPage?: number | undefined;
  /**
   * The oldest storefront client (`X-Client-Version`, semver) that renders
   * this type. The resolver leaves the block out for an older client, which
   * would otherwise draw a gap. Omitted: every client.
   */
  minClient?: string | undefined;
}

/** Upgrades props stored at version `n` to version `n + 1`. Must be pure. */
export type BlockMigration = (props: Record<string, unknown>) => Record<string, unknown>;

/** A zod object schema carrying the base props, as `blockProps()` builds it. */
export type BlockPropsSchema = z.ZodObject<z.ZodRawShape>;

export interface BlockDefinition<
  T extends string = string,
  P extends BlockPropsSchema = BlockPropsSchema,
> {
  type: T;
  /** Current schema version, ≥ 1. */
  v: number;
  props: P;
  meta: BlockMeta;
  /** `migrate[n]` upgrades version n to n + 1; one entry for every n in 1 … v − 1. */
  migrate?: Readonly<Record<number, BlockMigration>> | undefined;
  /**
   * The data this block needs, by slot, computed from its parsed props. The
   * resolver answers each slot in `block.data[slot]`. Omitted: a block that
   * needs nothing but its props.
   */
  data?: ((props: z.infer<P>) => Record<string, DataNeed>) | undefined;
  /**
   * The shopper's own data this block shows, by slot, computed from its parsed
   * props. Answered only with a session, never cached (DECOR-015), in
   * `personal[blockId][slot]`. Omitted: nothing personal.
   */
  personal?: ((props: z.infer<P>) => Record<string, PersonalNeed>) | undefined;
}

/** A definition with its prop type erased, as the registry stores it. */
export interface AnyBlockDefinition {
  type: string;
  v: number;
  props: BlockPropsSchema;
  meta: BlockMeta;
  migrate?: Readonly<Record<number, BlockMigration>> | undefined;
  data?: ((props: never) => Record<string, DataNeed>) | undefined;
  personal?: ((props: never) => Record<string, PersonalNeed>) | undefined;
}

const TYPE_PATTERN = /^[a-z][A-Za-z0-9]{1,39}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Declares a block type. Throws at module load on a declaration that could
 * not be served safely, so a mistake fails every test rather than one page.
 */
export function defineBlock<const T extends string, P extends BlockPropsSchema>(
  definition: BlockDefinition<T, P>,
): BlockDefinition<T, P> {
  const { type, v, props, meta, migrate } = definition;
  const fail = (reason: string): never => {
    throw new Error(`defineBlock(${type}): ${reason}`);
  };
  if (!TYPE_PATTERN.test(type)) fail('type must be camelCase ASCII, 2–40 characters');
  if (!Number.isInteger(v) || v < 1) fail('v must be an integer ≥ 1');
  for (const key of BASE_PROP_KEYS) {
    if (!(key in props.shape)) fail(`props must be built with blockProps() (missing "${key}")`);
  }
  if (meta.label.trim() === '') fail('meta.label is required');
  if (meta.pages.length === 0) fail('meta.pages must name at least one document kind');
  if (
    meta.maxPerPage !== undefined &&
    (!Number.isInteger(meta.maxPerPage) || meta.maxPerPage < 1)
  ) {
    fail('meta.maxPerPage must be a positive integer');
  }
  if (meta.minClient !== undefined && !SEMVER_PATTERN.test(meta.minClient)) {
    fail('meta.minClient must be x.y.z');
  }
  const steps = Object.keys(migrate ?? {})
    .map(Number)
    .sort((a, b) => a - b);
  const expected = Array.from({ length: v - 1 }, (_, index) => index + 1);
  if (steps.join(',') !== expected.join(',')) {
    fail(`migrate must have exactly the steps ${expected.join(', ') || '(none)'}`);
  }
  return definition;
}

export interface BlockRegistry {
  /** Registered types, in palette order. */
  readonly types: readonly string[];
  get(type: string): AnyBlockDefinition | undefined;
  has(type: string): boolean;
  list(): readonly AnyBlockDefinition[];
}

/** A registry over the given definitions. Injectable, so tests can register their own. */
export function createBlockRegistry(definitions: readonly AnyBlockDefinition[]): BlockRegistry {
  const byType = new Map<string, AnyBlockDefinition>();
  for (const definition of definitions) {
    if (byType.has(definition.type)) {
      throw new Error(`createBlockRegistry: block type "${definition.type}" is registered twice`);
    }
    byType.set(definition.type, definition);
  }
  const types = [...byType.keys()];
  return {
    types,
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    list: () => [...byType.values()],
  };
}

export type MigrationResult =
  | { ok: true; props: Record<string, unknown> }
  /** Stored at a version this build does not know yet: treat like an unknown block. */
  | { ok: false; reason: 'newer' }
  | { ok: false; reason: 'failed'; message: string };

/** Runs the migrations from the stored version `from` up to the definition's current one. */
export function migrateBlockProps(
  definition: AnyBlockDefinition,
  from: number,
  props: Record<string, unknown>,
): MigrationResult {
  if (from > definition.v) return { ok: false, reason: 'newer' };
  let current = props;
  for (let step = from; step < definition.v; step += 1) {
    const migration = definition.migrate?.[step];
    if (!migration) return { ok: false, reason: 'failed', message: `缺少 v${step} 的迁移` };
    try {
      current = migration(current);
    } catch (error) {
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, props: current };
}

/**
 * Compares two `x.y.z` versions: negative, 0 or positive. A value that is not
 * `x.y.z` (a missing or garbled header) compares as `null`, and the caller
 * decides — the resolver then serves every block.
 */
export function compareVersions(a: string, b: string): number | null {
  if (!SEMVER_PATTERN.test(a) || !SEMVER_PATTERN.test(b)) return null;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
