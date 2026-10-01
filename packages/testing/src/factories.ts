/**
 * Factory scaffold.
 *
 * A factory turns "I need an order" into one line, and makes the *interesting*
 * field of a test the only one written down. Domains define their own
 * (`catalogFactories.product`, …); this is the shared machinery.
 */

export interface Factory<TAttrs, TResult> {
  /** Build the attributes without touching the database. */
  attrs(overrides?: Partial<TAttrs>): TAttrs;
  /** Build and persist. */
  create(overrides?: Partial<TAttrs>): Promise<TResult>;
  /** `createMany(3, { status: 1 })` — sequence numbers still advance per row. */
  createMany(count: number, overrides?: Partial<TAttrs>): Promise<TResult[]>;
  /** Restart the sequence, for a test that asserts on a generated name. */
  reset(): void;
}

export interface FactoryDefinition<TAttrs, TResult> {
  /** `sequence` increments per built row, so unique columns stay unique. */
  build(sequence: number): TAttrs;
  insert(attrs: TAttrs): Promise<TResult>;
}

export function defineFactory<TAttrs extends object, TResult>(
  definition: FactoryDefinition<TAttrs, TResult>,
): Factory<TAttrs, TResult> {
  let sequence = 0;

  const attrs = (overrides: Partial<TAttrs> = {}): TAttrs => {
    sequence += 1;
    return { ...definition.build(sequence), ...overrides };
  };

  return {
    attrs,
    async create(overrides = {}) {
      return definition.insert(attrs(overrides));
    },
    async createMany(count, overrides = {}) {
      const out: TResult[] = [];
      // Sequential on purpose: parallel inserts make failures hard to read and
      // these are setup, not the thing under test.
      for (let i = 0; i < count; i += 1) out.push(await definition.insert(attrs(overrides)));
      return out;
    },
    reset() {
      sequence = 0;
    },
  };
}

/** `oneOf(['a','b'])(3)` — deterministic pseudo-choice driven by the sequence. */
export function oneOf<T>(values: readonly T[]): (sequence: number) => T {
  if (values.length === 0) throw new RangeError('oneOf: 需要至少一个候选值');
  return (sequence) => values[sequence % values.length]!;
}

/** Deterministic unique string, e.g. `seq('sku')(3) === 'sku-3'`. */
export function seq(prefix: string): (sequence: number) => string {
  return (sequence) => `${prefix}-${sequence}`;
}
