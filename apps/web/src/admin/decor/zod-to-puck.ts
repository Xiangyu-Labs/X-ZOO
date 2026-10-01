import type { CustomFieldRender, Field, Fields } from '@puckeditor/core';
import { unwrapSchema, type EditorFieldKind, type EditorMeta } from '@shop/contracts/decor/meta';
import type { z } from 'zod';

/**
 * Block prop schemas → Puck field definitions.
 *
 * The schema is the single source: its shape picks the control (string →
 * text, number → number, boolean → switch, enum or a union of literals →
 * segmented / select, array of an enum → multi-select, array of objects →
 * Puck's array editor, object → Puck's object editor) and its `.meta()` (see
 * `EditorMeta`, contracts `decor/meta.ts`) supplies the label, the option
 * labels, the number step, the group and the *semantic* kinds that need a
 * control of the admin's own — image, link, colour and the five data sources.
 *
 * Every control of the admin's own is a Puck `custom` field whose renderer the
 * caller passes in, so this module stays free of antd and is testable on its
 * own. The generic controls (`switch`, `choice`, `multiChoice`, `groupHeading`)
 * are optional: without them booleans and enums fall back to Puck's radio and
 * select, and an array of an enum is an error.
 *
 * Nothing here is Puck-specific beyond the returned shape: swapping the editor
 * means rewriting this one adapter, not the schemas.
 */

/** The semantic kinds the admin renders with a control of its own. */
export const SEMANTIC_FIELD_KINDS = [
  'image',
  'video',
  'link',
  'color',
  'productSource',
  'couponSource',
  'groupbuySource',
  'presaleSource',
  'articleSource',
  'richText',
  'hotspots',
] as const satisfies readonly EditorFieldKind[];
export type SemanticFieldKind = (typeof SEMANTIC_FIELD_KINDS)[number];

const SEMANTIC_KINDS: ReadonlySet<EditorFieldKind> = new Set<EditorFieldKind>(SEMANTIC_FIELD_KINDS);

/** One choice of an enum-like field, value typed as the schema has it. */
export interface ChoiceOption {
  label: string;
  value: string | number | boolean;
}

/**
 * What a custom field's renderer finds on `field.metadata`: the schema's
 * editor metadata, whether the value may be left empty and, for choices, the
 * options and the control the schema asked for.
 */
export interface DecorFieldMetadata {
  meta: EditorMeta | undefined;
  optional: boolean;
  options?: ChoiceOption[] | undefined;
  /** For a `choice`: `radio` draws every option at once, `select` a dropdown. */
  control?: 'radio' | 'select' | undefined;
  /** For a `multiChoice`: the most that may be picked. */
  max?: number | undefined;
  [key: string]: unknown;
}

/**
 * The prefix of the inspector-only pseudo fields that draw a group heading.
 * They never hold a value; `toPageDocument` drops any key with this prefix.
 */
export const GROUP_FIELD_PREFIX = '__group:';

type AnyRender = CustomFieldRender<any>;

export type CustomFieldRenderers = Readonly<Record<SemanticFieldKind, AnyRender>> & {
  /** A boolean. Without it: a 开/关 radio. */
  readonly switch?: AnyRender | undefined;
  /** An enum or union of literals. Without it: Puck's radio / select. */
  readonly choice?: AnyRender | undefined;
  /** An array of an enum. Without it: an error (or `unsupported`). */
  readonly multiChoice?: AnyRender | undefined;
  /** Draws a group heading between top-level fields. Without it: no headings. */
  readonly groupHeading?: AnyRender | undefined;
  /**
   * Renders a schema shape the adapter has no control for (a discriminated
   * union without a semantic kind, a record, …). Without it such a prop is an
   * error, so a new schema shape cannot silently vanish from the inspector.
   */
  readonly unsupported?: AnyRender | undefined;
};

type AnyDef = {
  type: string;
  checks?: readonly { _zod: { def: { check: string; minimum?: number; maximum?: number } } }[];
  entries?: Record<string, string | number>;
  options?: readonly z.ZodType[];
  values?: readonly unknown[];
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
};

function defOf(schema: z.ZodType): AnyDef {
  return schema._zod.def as unknown as AnyDef;
}

/** `min_length` / `max_length` checks of a string or an array. */
function lengthBounds(def: AnyDef): { min?: number; max?: number } {
  const bounds: { min?: number; max?: number } = {};
  for (const check of def.checks ?? []) {
    const own = check._zod.def;
    if (own.check === 'min_length' && own.minimum !== undefined) bounds.min = own.minimum;
    if (own.check === 'max_length' && own.maximum !== undefined) bounds.max = own.maximum;
  }
  return bounds;
}

function optionLabel(meta: EditorMeta | undefined, value: string | number | boolean): string {
  return meta?.options?.[String(value)] ?? String(value);
}

/** The values of an enum, or of a union whose every member is a literal; else `undefined`. */
function choiceValues(def: AnyDef): (string | number | boolean)[] | undefined {
  if (def.type === 'enum' && def.entries) return Object.values(def.entries);
  if (def.type === 'union' && def.options) {
    const values: (string | number | boolean)[] = [];
    for (const option of def.options) {
      const own = defOf(option);
      if (own.type !== 'literal' || !own.values) return undefined;
      for (const value of own.values) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          return undefined;
        }
        values.push(value);
      }
    }
    return values;
  }
  return undefined;
}

/**
 * The props a new array item starts with: each key's `.default()`, else an
 * empty value of its type. Optional keys are left out.
 */
export function defaultsOf(schema: z.ZodType): unknown {
  const { schema: inner, optional, defaultValue } = unwrapSchema(schema);
  if (defaultValue !== undefined) {
    // Through the schema, not the raw value: a `.prefault({})` default is an
    // *input* that the inner defaults still have to fill.
    const parsed = schema.safeParse(undefined);
    return parsed.success ? parsed.data : structuredClone(defaultValue);
  }
  if (optional) return undefined;
  const def = defOf(inner);
  switch (def.type) {
    case 'string':
      return '';
    case 'number': {
      const min = (inner as unknown as { minValue: number | null }).minValue;
      return min !== null && Number.isFinite(min) ? min : 0;
    }
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        const value = defaultsOf(child);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    default: {
      const values = choiceValues(def);
      return values?.[0];
    }
  }
}

/**
 * The props a block starts with when dropped on the page: the schema's
 * defaults, plus the minimum number of items a required list needs (each from
 * the item schema's defaults). Images start empty, so a new block is invalid
 * until the operator picks them — by design (convention 7).
 */
export function initialPropsOf(schema: z.ZodObject): Record<string, unknown> {
  const props = (defaultsOf(schema) ?? {}) as Record<string, unknown>;
  for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    const { schema: inner, defaultValue, optional } = unwrapSchema(child);
    const def = defOf(inner);
    if (def.type !== 'array' || defaultValue !== undefined || optional || !def.element) continue;
    const { min = 0 } = lengthBounds(def);
    props[key] = Array.from({ length: min }, () => defaultsOf(def.element!));
  }
  return props;
}

function fieldFor(name: string, schema: z.ZodType, custom: CustomFieldRenderers): Field | null {
  const { schema: inner, meta, optional } = unwrapSchema(schema);
  if (meta?.hidden) return null;
  const label = meta?.label ?? name;
  const metadata: DecorFieldMetadata = { meta, optional };
  const kind = meta?.field;

  if (kind && SEMANTIC_KINDS.has(kind)) {
    return { type: 'custom', label, metadata, render: custom[kind as SemanticFieldKind] };
  }

  const def = defOf(inner);
  const choices = choiceValues(def);
  if (choices) {
    const options = choices.map((value) => ({ label: optionLabel(meta, value), value }));
    // A few short options read better side by side; the schema can ask either way.
    const control =
      kind === 'radio' || (kind !== 'select' && choices.length <= 4) ? 'radio' : 'select';
    if (custom.choice) {
      return {
        type: 'custom',
        label,
        metadata: { ...metadata, options, control },
        render: custom.choice,
      };
    }
    return { type: control, label, metadata, options };
  }

  switch (def.type) {
    case 'string':
      return {
        type: kind === 'textarea' ? 'textarea' : 'text',
        label,
        metadata,
        ...(meta?.placeholder ? { placeholder: meta.placeholder } : {}),
      };
    case 'number': {
      const bounds = inner as unknown as { minValue: number | null; maxValue: number | null };
      return {
        type: 'number',
        label,
        metadata,
        ...(bounds.minValue !== null && Number.isFinite(bounds.minValue)
          ? { min: bounds.minValue }
          : {}),
        ...(bounds.maxValue !== null && Number.isFinite(bounds.maxValue)
          ? { max: bounds.maxValue }
          : {}),
        ...(meta?.step !== undefined ? { step: meta.step } : {}),
      };
    }
    case 'boolean':
      if (custom.switch) return { type: 'custom', label, metadata, render: custom.switch };
      // Puck has no switch; a boolean radio stores a real boolean.
      return {
        type: 'radio',
        label,
        metadata,
        options: [
          { label: '开', value: true },
          { label: '关', value: false },
        ],
      };
    case 'array': {
      const element = def.element;
      if (!element) break;
      const elementDef = defOf(unwrapSchema(element).schema);
      const elementChoices = choiceValues(elementDef);
      if (elementChoices) {
        if (!custom.multiChoice) break;
        const elementMeta = unwrapSchema(element).meta;
        const labels = meta?.options ? meta : elementMeta;
        const options = elementChoices.map((value) => ({
          label: optionLabel(labels, value),
          value,
        }));
        const { max } = lengthBounds(def);
        return {
          type: 'custom',
          label,
          metadata: { ...metadata, options, ...(max !== undefined ? { max } : {}) },
          render: custom.multiChoice,
        };
      }
      if (elementDef.type !== 'object') break;
      const { min, max } = lengthBounds(def);
      const itemLabel = meta?.itemLabel;
      const itemName = unwrapSchema(element).meta?.label ?? label;
      return {
        type: 'array',
        label,
        metadata,
        arrayFields: fieldsOf(unwrapSchema(element).schema as z.ZodObject, custom),
        defaultItemProps: () => defaultsOf(element) as Record<string, unknown>,
        getItemSummary: (item: Record<string, unknown>, index = 0) => {
          const text = itemLabel ? item[itemLabel] : undefined;
          return typeof text === 'string' && text ? text : `${itemName} ${index + 1}`;
        },
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      };
    }
    case 'object':
      return {
        type: 'object',
        label,
        metadata,
        objectFields: fieldsOf(inner as z.ZodObject, custom),
      };
    default:
      break;
  }

  if (custom.unsupported) {
    return { type: 'custom', label, metadata, render: custom.unsupported };
  }
  throw new Error(`zodToPuckFields: no editor control for "${name}" (zod type "${def.type}")`);
}

function fieldsOf(schema: z.ZodObject, custom: CustomFieldRenderers): Fields {
  const fields: Fields = {};
  for (const [name, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    const field = fieldFor(name, child, custom);
    if (field) fields[name] = field;
  }
  return fields;
}

/**
 * Top-level fields in group order (convention 5 of `meta.ts`): fields without
 * a group first, then each group in first-appearance order under a heading.
 *
 * A group that is a single object field already labelled with the group's
 * name (the shared `样式` / `显示`) gets no heading of its own: the object
 * field's frame is the heading.
 */
function grouped(schema: z.ZodObject, fields: Fields, heading: AnyRender): Fields {
  const groupOf = new Map<string, string | undefined>();
  for (const [name, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    groupOf.set(name, unwrapSchema(child).meta?.group);
  }
  const loose: string[] = [];
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(fields)) {
    const group = groupOf.get(name);
    if (!group) {
      loose.push(name);
      continue;
    }
    groups.set(group, [...(groups.get(group) ?? []), name]);
  }
  if (groups.size === 0) return fields;

  const out: Fields = {};
  for (const name of loose) out[name] = fields[name]!;
  for (const [group, names] of groups) {
    const only = names.length === 1 ? fields[names[0]!] : undefined;
    const selfTitled = only?.type === 'object' && only.label === group;
    if (!selfTitled) {
      out[`${GROUP_FIELD_PREFIX}${group}`] = {
        type: 'custom',
        label: group,
        metadata: { meta: undefined, optional: true, heading: true },
        render: heading,
      };
    }
    for (const name of names) out[name] = fields[name]!;
  }
  return out;
}

/**
 * Puck `fields` for a block's (or the page root's) prop schema.
 *
 * Throws on a prop the adapter has no control for, unless `custom.unsupported`
 * is given — a schema change must show up in the editor or fail loudly.
 */
export function zodToPuckFields(schema: z.ZodObject, custom: CustomFieldRenderers): Fields {
  const fields = fieldsOf(schema, custom);
  return custom.groupHeading ? grouped(schema, fields, custom.groupHeading) : fields;
}
