import type { z } from 'zod';

/**
 * Editor metadata on a block's prop schema, carried by zod 4's `.meta()`.
 *
 * The admin editor (a Puck adapter, `apps/web/src/admin/decor/zod-to-puck.ts`)
 * builds every block's form from the block's zod schema and this metadata; no
 * form is written by hand. The storefront and the server ignore it. Nothing
 * here may depend on React or on the editor library.
 *
 * ## Conventions (what the adapter relies on)
 *
 * 1. **Every field the operator edits has `ui({ label })`.** A field without a
 *    label is a programming error; the adapter throws rather than showing a
 *    raw key.
 * 2. **Attach `.meta()` anywhere on the wrapper chain.** `.meta()` may be
 *    called before or after `.optional()` / `.default()` / `.prefault()`;
 *    `unwrapSchema` merges them, the outer call winning key by key. Give a
 *    reused schema (`color`, `imageUrl`, `linkTarget`) a generic label at its
 *    definition and the specific one at the use site.
 * 3. **The control is inferred from the schema** — string → text, number →
 *    number (bounds from `.min()` / `.max()`), boolean → switch, enum or union
 *    of literals → select (`radio` when ≤ 4 choices), array of objects → list,
 *    array of an enum → multi-select (the enum's `options` label the choices),
 *    object → group. Set `field` only to override that, or for a *semantic*
 *    kind the inference cannot see: `color`, `image`, `video`, `link`, `richText`,
 *    `hotspots` and the data
 *    sources (`productSource`, `couponSource`, `groupbuySource`,
 *    `presaleSource`, `articleSource`). Semantic kinds are rendered by the
 *    admin's own pickers, and the server finds links and data sources in a
 *    document by these kinds (`collectFields` in `document.ts`) — so a link
 *    or a source **must** carry its kind, or it is neither validated nor
 *    resolved.
 * 4. **Enum labels** go in `options` (value → label). A value missing from
 *    `options` shows raw.
 * 5. **Grouping.** `group` puts a field under a heading, in first-appearance
 *    order. The shared base props (`style`, `visibility`) carry the groups
 *    `样式` and `显示`.
 * 6. **Arrays.** `itemLabel` names the item key shown in the collapsed row.
 *    `.min()` / `.max()` bound the list; new items start from the item
 *    schema's defaults.
 * 7. **Defaults are the schema's.** Every field a new block needs has a
 *    `.default()`; a required field without one (an image) makes a new block
 *    invalid until the operator fills it — deliberately, so publishing is
 *    blocked on it.
 * 8. **`hidden: true`** keeps a field out of the form; it is still validated
 *    and stored.
 * 9. Labels, help and placeholders are Simplified Chinese.
 *
 * ```ts
 * z.number().int().min(0).max(40).default(20).meta(ui({ label: '间距', group: '样式' }))
 * ```
 */

/**
 * The control an editor should use for a value. Omitted → inferred from the
 * schema (convention 3).
 */
export type EditorFieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'switch'
  | 'array'
  | 'object'
  | 'color'
  | 'image'
  /** An uploaded video (mp4), picked from the asset library. */
  | 'video'
  | 'link'
  /** Sanitised HTML (`rich-text.ts`), edited in a WYSIWYG box. */
  | 'richText'
  /** Rectangles in % over the block's `image` (热区图), drawn on the picture. */
  | 'hotspots'
  | 'productSource'
  | 'couponSource'
  | 'groupbuySource'
  | 'presaleSource'
  | 'articleSource';

/** The semantic kinds that name a data source; the resolver keys its work on them. */
export const SOURCE_FIELD_KINDS = [
  'productSource',
  'couponSource',
  'groupbuySource',
  'presaleSource',
  'articleSource',
] as const satisfies readonly EditorFieldKind[];
export type SourceFieldKind = (typeof SOURCE_FIELD_KINDS)[number];

// A type alias, not an interface: zod's `GlobalMeta` has an index signature,
// which an interface is not assignable to.
export type EditorMeta = {
  /** Field label, Simplified Chinese. */
  label: string;
  field?: EditorFieldKind | undefined;
  /** Groups fields under a heading in the inspector, in first-appearance order. */
  group?: string | undefined;
  help?: string | undefined;
  placeholder?: string | undefined;
  /** Enum value → label, for `select` / `radio`. Missing values show the raw value. */
  options?: Readonly<Record<string, string>> | undefined;
  /** For arrays: which item key names an item in the collapsed list. */
  itemLabel?: string | undefined;
  /** For numbers, when the schema has no `.min()`/`.max()` or the control needs a step. */
  step?: number | undefined;
  /** Hidden from the editor (still validated and stored). */
  hidden?: boolean | undefined;
};

/** Typed helper for `.meta()`: `z.string().meta(ui({ label: '标题' }))`. */
export function ui(meta: EditorMeta): EditorMeta {
  return meta;
}

function isEditorMeta(value: unknown): value is EditorMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { label?: unknown }).label === 'string'
  );
}

/** The wrapper types whose inner schema carries the value shape. */
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly']);

export interface Unwrapped {
  /** The innermost, non-wrapper schema. */
  schema: z.ZodType;
  /** Metadata merged from the outermost wrapper inwards; the outer value wins. */
  meta: EditorMeta | undefined;
  optional: boolean;
  /** The value `.default()` supplies, if any. */
  defaultValue: unknown;
}

/**
 * Peels `optional` / `nullable` / `default` / … off a schema and collects the
 * editor metadata attached at any level (convention 2).
 */
export function unwrapSchema(schema: z.ZodType): Unwrapped {
  let current = schema;
  let meta: EditorMeta | undefined;
  let optional = false;
  let defaultValue: unknown;
  for (;;) {
    const own = current.meta();
    if (isEditorMeta(own)) meta = { ...own, ...meta };
    const def = current._zod.def as { type: string; innerType?: z.ZodType; defaultValue?: unknown };
    if (!WRAPPERS.has(def.type) || !def.innerType) break;
    if (def.type === 'optional' || def.type === 'nullable') optional = true;
    if ((def.type === 'default' || def.type === 'prefault') && defaultValue === undefined) {
      defaultValue = def.defaultValue;
    }
    current = def.innerType;
  }
  return { schema: current, meta, optional, defaultValue };
}
