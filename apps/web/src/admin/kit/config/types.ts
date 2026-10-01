/**
 * Descriptor types for `<ConfigGroupForm>`.
 *
 * Deliberately minimal and data-only (no functions in the default shape, no
 * zod) so that `defineConfigGroup` in `core/system/config/<group>.config.ts`
 * can emit one straight over the wire, and so the shapes can round-trip through
 * JSON. Anything richer belongs in the group's own page, not here.
 */

export type ConfigFieldKind =
  | 'text'
  | 'password'
  | 'number'
  | 'money'
  | 'switch'
  | 'select'
  | 'textarea'
  | 'asset'
  | 'json'
  | 'color'
  | 'richtext'
  | 'url';

/** What a `number` counts. `bytes` is edited in MB and stored in bytes. */
export type ConfigFieldUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'ms' | 'bytes' | 'items';

export interface ConfigSelectOption {
  label: string;
  value: string | number | boolean;
}

/** Data-only conditional visibility: show when `values[key]` matches. */
export interface ConfigVisibleWhen {
  key: string;
  /** A single value, or any of a list. */
  equals: unknown;
}

export interface ConfigFieldDescriptor {
  /** Key inside the group. The saved payload is `{ [key]: value }`. */
  key: string;
  label: string;
  /** Grey hint under the control. */
  help?: string | undefined;
  kind: ConfigFieldKind;
  options?: ConfigSelectOption[] | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
  visibleWhen?: (ConfigVisibleWhen | ((values: ConfigValues) => boolean)) | undefined;
  /**
   * Heading this field sits under. Fields with no section come first, and a
   * descriptor where no field has one renders exactly as it did before.
   */
  section?: string | undefined;
  /**
   * Shown as plain text, with no control and no place in the saved payload.
   *
   * The value belongs to the deployment rather than to the operator —
   * `site.publicOrigin` comes from an environment variable. `help` says which
   * one. The server refuses the key independently, so a stale tab is refused
   * rather than obeyed.
   */
  readOnly?: boolean | undefined;
  /** `asset` only. */
  multiple?: boolean | undefined;
  max?: number | undefined;
  /** `number` only. */
  min?: number | undefined;
  /** `number` only: shown as a suffix; `bytes` is edited in MB. */
  unit?: ConfigFieldUnit | undefined;
  /** Width out of 24 at `md`+. Defaults to the form's `columns` setting. */
  span?: number | undefined;
}

/** The group's 「测试」 button. The hook runs on the server. */
export interface ConfigTestDescriptor {
  label: string;
  /** Asked before running, when the test costs money or reaches a real person. */
  confirm?: string | undefined;
  /** Filled in by the operator before running, e.g. the phone to text. */
  inputs: ConfigFieldDescriptor[];
  /** Keys of `inputs` the operator may leave blank. */
  optional?: string[] | undefined;
}

export interface ConfigGroupDescriptor {
  /** Registry group name, e.g. `payment`. Also the route param. */
  group: string;
  title: string;
  description?: string | undefined;
  fields: ConfigFieldDescriptor[];
  test?: ConfigTestDescriptor | undefined;
}

/**
 * Current values for a group.
 *
 * **Secrets**: a `password` field's value is a *boolean*, not the secret —
 * `true` means 已设置, `false`/absent means 未设置. The server never sends a
 * stored secret back, and the form only includes a `password` key in the saved
 * payload when the operator typed a new value.
 */
export type ConfigValues = Record<string, unknown>;

export function isConfigFieldVisible(field: ConfigFieldDescriptor, values: ConfigValues): boolean {
  const condition = field.visibleWhen;
  if (!condition) return true;
  if (typeof condition === 'function') return condition(values);
  const actual = values[condition.key];
  return Array.isArray(condition.equals)
    ? condition.equals.includes(actual)
    : actual === condition.equals;
}

/**
 * Builds the payload to save.
 *
 * Every visible, writable, non-secret field is included. A `password` field is
 * included only when `secrets[key]` holds something the operator typed, so
 * saving an unrelated setting can never blank out a stored credential; a
 * `readOnly` field is never included at all, so saving the site name does not
 * post back an origin the server would then refuse.
 */
export function buildConfigPayload(
  descriptor: ConfigGroupDescriptor,
  formValues: ConfigValues,
  secrets: Record<string, string>,
): ConfigValues {
  const payload: ConfigValues = {};
  for (const field of descriptor.fields) {
    if (!isConfigFieldVisible(field, formValues)) continue;
    if (field.readOnly === true) continue;
    if (field.kind === 'password') {
      const typed = secrets[field.key];
      if (typed !== undefined && typed !== '') payload[field.key] = typed;
      continue;
    }
    payload[field.key] = formValues[field.key];
  }
  return payload;
}

/** `undefined`, `null` and `''` are all "nothing there" to an operator. */
function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  if (blank(a) && blank(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The keys whose value on the screen differs from the saved one: every visible,
 * writable field, plus each secret the operator typed something into.
 */
export function changedConfigKeys(
  descriptor: ConfigGroupDescriptor,
  formValues: ConfigValues,
  saved: ConfigValues | undefined,
  secrets: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const field of descriptor.fields) {
    if (field.readOnly === true) continue;
    if (field.kind === 'password') {
      if ((secrets[field.key] ?? '') !== '') out.push(field.key);
      continue;
    }
    if (!isConfigFieldVisible(field, formValues)) continue;
    if (!(field.key in formValues)) continue;
    if (!sameValue(formValues[field.key], saved?.[field.key])) out.push(field.key);
  }
  return out;
}
