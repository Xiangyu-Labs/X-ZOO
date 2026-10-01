import type { FormInstance, FormRule } from 'antd';
import { z } from 'zod';

import { ApiError, parseFieldErrors } from '../../api/errors';
import { toNamePath, type FieldName, type FieldSpec } from './types';

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

/** The schema for one top-level field, or `undefined` for nested/unknown paths. */
export function fieldSchemaOf(schema: AnyObjectSchema, name: FieldName): z.ZodType | undefined {
  const path = toNamePath(name);
  if (path.length !== 1) return undefined;
  const key = String(path[0]);
  return (schema.shape as Record<string, z.ZodType | undefined>)[key];
}

/**
 * Whether zod would reject `undefined` for this field — which is exactly what
 * "required" means to an operator. Fields with a `.default()` are not required.
 */
export function isFieldRequired(schema: AnyObjectSchema, name: FieldName): boolean {
  const field = fieldSchemaOf(schema, name);
  if (!field) return false;
  return !field.safeParse(undefined).success;
}

/**
 * The longest text the contract takes for a field — `z.string().max(n)`, through
 * any `.optional()`, `.nullable()`, `.default()` or transform — so the input can
 * stop at it and count towards it, instead of the operator learning the limit
 * from an error after typing past it.
 */
export function maxLengthOf(field: z.ZodType | undefined): number | undefined {
  let current: z.ZodType | undefined = field;
  for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (current instanceof z.ZodString) return current.maxLength ?? undefined;
    const def = current.def as { innerType?: z.ZodType; in?: z.ZodType };
    current = def.innerType ?? def.in;
  }
  return undefined;
}

function isBlank(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

function accepts(field: z.ZodType, value: unknown): boolean {
  return field.safeParse(value).success;
}

/**
 * What an emptied control means to the contract.
 *
 * A cleared `InputNumber` or `DatePicker` gives `null`, a cleared `Input` gives
 * `''`. Sent as they are, an optional number fails 「期望 number」 and can never
 * be cleared, and an optional text arrives as `''`, which the conventions say
 * is never a value. So an empty value becomes the "nothing" the field accepts:
 * `null` when the field takes it (the explicit clear an update needs), absent
 * when it is optional, and absent otherwise — which a required field then
 * refuses with 请填写….
 */
export function emptyValueFor(field: z.ZodType | undefined, value: unknown): unknown {
  if (!isBlank(value)) return value;
  if (field === undefined) return value === null ? undefined : value;
  if (accepts(field, null)) return null;
  return undefined;
}

/** Kinds whose text is trimmed on submit. A password is taken exactly as typed. */
const TRIMMED_KINDS = new Set(['text', 'textarea']);

/**
 * The raw form value as the contract should see it: blank fields normalised by
 * `emptyValueFor`, and the text of text fields trimmed — 「 张三 」 is 张三 to
 * an operator, and a trailing space in a tracking number is a support ticket.
 */
export function normaliseFormValues(
  schema: AnyObjectSchema,
  raw: unknown,
  fields: readonly Pick<FieldSpec, 'kind' | 'name'>[] = [],
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const trimmed = new Set(
    fields
      .filter((spec) => TRIMMED_KINDS.has(spec.kind) && toNamePath(spec.name).length === 1)
      .map((spec) => String(toNamePath(spec.name)[0])),
  );
  const shape = schema.shape as Record<string, z.ZodType | undefined>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const text = trimmed.has(key) && typeof value === 'string' ? value.trim() : value;
    const normalised = emptyValueFor(shape[key], text);
    if (normalised !== undefined) out[key] = normalised;
  }
  return out;
}

/** 请选择 for a control you pick from, 请上传 for an image, 请填写 for what you type. */
function emptyMessage(spec: Pick<FieldSpec, 'kind' | 'label'> | undefined): string | null {
  if (spec === undefined || typeof spec.label !== 'string' || spec.label === '') return null;
  switch (spec.kind) {
    case 'asset':
      return `请上传${spec.label}`;
    case 'select':
    case 'radio':
    case 'checkbox':
    case 'date':
    case 'dateRange':
    case 'treeSelect':
    case 'cascader':
    case 'link':
      return `请选择${spec.label}`;
    default:
      return `请填写${spec.label}`;
  }
}

/**
 * An antd rule that runs the field's own zod schema. Cross-field refinements
 * cannot be expressed per field, so they are caught by the whole-object parse
 * in `ZodForm`'s submit handler and mapped back with `setFields`.
 *
 * An empty required field says 请填写<label> (请选择 for a picker), not what
 * zod thinks of `undefined`.
 */
export function zodFieldRule(
  schema: AnyObjectSchema,
  name: FieldName,
  spec?: Pick<FieldSpec, 'kind' | 'label'> | undefined,
): FormRule | null {
  const field = fieldSchemaOf(schema, name);
  if (!field) return null;
  const trims = spec !== undefined && TRIMMED_KINDS.has(spec.kind);
  return {
    async validator(_rule: unknown, value: unknown) {
      const text = trims && typeof value === 'string' ? value.trim() : value;
      const candidate = emptyValueFor(field, text);
      const result = field.safeParse(candidate);
      if (result.success) return;
      if (candidate === undefined || candidate === null) {
        const message = emptyMessage(spec);
        if (message !== null) throw new Error(message);
      }
      throw new Error(result.error.issues[0]?.message ?? '输入有误');
    },
  };
}

/** Where each error landed: on a field the form renders, or nowhere. */
export interface FieldErrorMatch {
  /** Named exactly as the field registered, so `form.setFields` finds it. */
  matched: { name: (string | number)[]; errors: string[] }[];
  /** Messages no rendered field can show, each once. They belong in a banner. */
  unmatched: string[];
}

/**
 * Matches error paths (`'skus.1.price'`) against the fields a form renders.
 *
 * - Segments compare as strings, so `'a.0.b'` finds a field named
 *   `['a', 0, 'b']` as well as one named `'a.0.b'`.
 * - A path with no field of its own lands on the nearest field that holds it:
 *   `skus.1.price` shows under a `custom` field named `skus`.
 * - `prefix` is stripped first when present: a settings form sends its fields
 *   as `{ values: {...} }`, so the server names them `values.siteName`.
 * - Anything else, `params.id` or a field that is not on screen, is returned
 *   in `unmatched` rather than dropped.
 */
export function matchFieldErrors(
  errors: Readonly<Record<string, string | readonly string[]>>,
  fieldNames: readonly FieldName[],
  options: { prefix?: string | undefined } = {},
): FieldErrorMatch {
  const fields = new Map<string, (string | number)[]>();
  for (const name of fieldNames) {
    const path = toNamePath(name);
    if (path.length > 0) fields.set(pathKey(path), path);
  }

  const byField = new Map<string, { name: (string | number)[]; errors: string[] }>();
  const unmatched = new Set<string>();
  for (const [raw, messages] of Object.entries(errors)) {
    const list = typeof messages === 'string' ? [messages] : messages;
    const target = nearestField(fields, stripPrefix(raw, options.prefix));
    if (!target) {
      for (const message of list) unmatched.add(message);
      continue;
    }
    const key = pathKey(target);
    const entry = byField.get(key) ?? { name: target, errors: [] };
    for (const message of list) if (!entry.errors.includes(message)) entry.errors.push(message);
    byField.set(key, entry);
  }
  return { matched: [...byField.values()], unmatched: [...unmatched] };
}

/**
 * The 422 field errors in `error` matched against `fieldNames`, or `null` when
 * `error` is not a 422 that names any field. `parseFieldErrors` knows every
 * `details` shape: `handle()`'s `{ field, message }` list, zod `flatten()`, a
 * flat `{field: message}` map and a raw issue list.
 */
export function matchApiError(
  error: unknown,
  fieldNames: readonly FieldName[],
  options: { prefix?: string | undefined } = {},
): FieldErrorMatch | null {
  if (!ApiError.is(error) || error.status !== 422) return null;
  const fieldErrors = parseFieldErrors(error.details);
  return fieldErrors ? matchFieldErrors(fieldErrors, fieldNames, options) : null;
}

/** Shows matched errors on their fields. Unmatched ones are the caller's to show. */
export function applyFieldErrors(form: FormInstance, matched: FieldErrorMatch['matched']): void {
  if (matched.length > 0) form.setFields(matched);
}

/** Pushes zod issues onto the fields that render them, and returns the rest. */
export function applyZodIssues(
  form: FormInstance,
  error: z.ZodError,
  fieldNames: readonly FieldName[],
): FieldErrorMatch {
  const byPath: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.');
    (byPath[key] ??= []).push(issue.message);
  }
  const match = matchFieldErrors(byPath, fieldNames);
  applyFieldErrors(form, match.matched);
  return match;
}

function pathKey(path: readonly (string | number)[]): string {
  return JSON.stringify(path.map(String));
}

function stripPrefix(path: string, prefix: string | undefined): string {
  return prefix !== undefined && path.startsWith(`${prefix}.`)
    ? path.slice(prefix.length + 1)
    : path;
}

function nearestField(
  fields: ReadonlyMap<string, (string | number)[]>,
  path: string,
): (string | number)[] | undefined {
  if (path === '') return undefined;
  const segments = path.split('.');
  for (let length = segments.length; length > 0; length -= 1) {
    const found = fields.get(pathKey(segments.slice(0, length)));
    if (found) return found;
  }
  return undefined;
}
