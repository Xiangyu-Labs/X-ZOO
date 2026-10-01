/**
 * Strips `undefined` entries so an options bag can be spread into a component
 * whose props are declared `prop?: T` (without `| undefined`).
 *
 * The workspace runs with `exactOptionalPropertyTypes`, which — correctly —
 * rejects `<Foo bar={maybeUndefined} />` for such a prop. Rather than writing
 * a conditional spread per prop, build the bag and hand it to `defined`.
 *
 * ```tsx
 * <InputNumber {...defined({ min: spec.min, max: spec.max })} disabled={off} />
 * ```
 */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export function defined<T extends object>(props: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Defined<T>;
}
