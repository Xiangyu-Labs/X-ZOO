import { z } from 'zod';

import { color, imageUrl } from './base';
import { decorBlocks } from './all-blocks';
import { DECOR_LIMITS, DOCUMENT_KINDS, type DocumentKind } from './constants';
import { ui, unwrapSchema, type EditorFieldKind } from './meta';
import { migrateBlockProps, type BlockRegistry } from './registry';

/**
 * The DIY v2 page document (plan §2.1).
 *
 * ```
 * PageDocument = { schemaVersion: 2, root: { props }, blocks: Block[] }
 * Block        = { id, type, v, props }
 * ```
 *
 * The same shape is the editor's draft, a published revision and (with each
 * block's resolved `data` beside its props) what the storefront receives.
 *
 * Two levels of checking:
 *
 * - **The envelope** (`pageDocumentEnvelope`): the frame, the block ids, the
 *   hard limits. A draft that fails it is refused outright.
 * - **The content** (`checkDocument`): every block's props against its type's
 *   schema, after migration; root props; which page kind may hold which
 *   block. A draft is saved even with content issues — the editor shows them
 *   and an operator's half-finished work is never thrown away — but a document
 *   with any issue cannot be published.
 */

export const pageRootProps = z.object({
  title: z
    .string()
    .min(1, '请填写页面标题')
    .max(30)
    .default('微页面')
    .meta(ui({ label: '页面标题' })),
  background: color.default('#f5f5f5').meta(ui({ label: '页面背景色' })),
  shareEnabled: z
    .boolean()
    .default(true)
    .meta(ui({ label: '允许分享', group: '分享' })),
  shareTitle: z
    .string()
    .max(40)
    .default('')
    .meta(ui({ label: '分享标题（留空用页面标题）', group: '分享' })),
  shareImage: imageUrl
    .optional()
    .meta(ui({ label: '分享图（留空用页面截图）', field: 'image', group: '分享' })),
});
export type PageRootProps = z.infer<typeof pageRootProps>;

export const blockId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, '块 id 只能包含字母、数字、- 和 _');

/**
 * One block in the envelope. `props` is an open record here: each known type
 * is checked by `checkDocument`, and an unknown type passes through untouched
 * (an older reader skips it instead of failing the page).
 */
export const pageBlock = z.object({
  id: blockId,
  type: z.string().min(1).max(40),
  v: z.number().int().positive(),
  props: z.record(z.string(), z.unknown()),
});
export type PageBlock = z.infer<typeof pageBlock>;

/** What a draft must be before it can even be stored. */
export const pageDocumentEnvelope = z.object({
  schemaVersion: z.literal(2),
  root: z.object({ props: z.record(z.string(), z.unknown()) }),
  blocks: z.array(pageBlock).max(DECOR_LIMITS.blocks, `一个页面最多 ${DECOR_LIMITS.blocks} 个组件`),
});
export type StoredDocument = z.infer<typeof pageDocumentEnvelope>;

/** A document whose root props parsed: every published revision. */
export const pageDocument = pageDocumentEnvelope.extend({
  root: z.object({ props: pageRootProps }),
});
export type PageDocument = z.infer<typeof pageDocument>;

export const documentIssue = z.object({
  /** Dotted path into the document: `blocks.2.props.slides.0.image`. */
  path: z.string(),
  message: z.string(),
});
export type DocumentIssue = z.infer<typeof documentIssue>;

export interface CheckedDocument {
  ok: true;
  /**
   * The document to store: blocks migrated to their current version with
   * defaults filled in wherever their props parsed; anything that did not
   * parse (and every unknown block) exactly as it came.
   */
  document: StoredDocument;
  /** Problems that block publishing. */
  issues: DocumentIssue[];
  /** Worth showing, never blocking (an unknown block type). */
  warnings: DocumentIssue[];
  /** Block types this build does not know, or knows only at an older version. */
  unknownBlocks: string[];
}

export type DocumentCheck = CheckedDocument | { ok: false; issues: DocumentIssue[] };

export interface CheckOptions {
  /** The page kind being checked; blocks not allowed there are issues. Omitted: any kind. */
  kind?: DocumentKind | undefined;
  registry?: BlockRegistry | undefined;
}

function toIssues(error: z.ZodError, prefix: readonly (string | number)[]): DocumentIssue[] {
  return error.issues.map((issue) => ({
    path: [...prefix, ...issue.path].map(String).join('.'),
    message: issue.message,
  }));
}

/** UTF-8 size of the document as stored. */
export function documentBytes(document: unknown): number {
  return new TextEncoder().encode(JSON.stringify(document)).length;
}

/**
 * Checks a document: the envelope (fatal), then its content (issues).
 *
 * - Every block id is unique.
 * - A known block is migrated to its current version, then parsed against its
 *   schema; a block not allowed on `kind`, or over its `maxPerPage`, is an issue.
 * - An unknown type, or a version newer than this build's, is kept as it is
 *   and reported as a warning and in `unknownBlocks`, and — since nothing can
 *   vouch for it — as an issue too: it can be saved, not published.
 * - At most `DECOR_LIMITS.dataBlocks` blocks may need server data, and the
 *   whole document must fit `DECOR_LIMITS.documentBytes`.
 */
export function checkDocument(input: unknown, options: CheckOptions = {}): DocumentCheck {
  const registry = options.registry ?? decorBlocks;
  const envelope = pageDocumentEnvelope.safeParse(input);
  if (!envelope.success) return { ok: false, issues: toIssues(envelope.error, []) };
  if (documentBytes(envelope.data) > DECOR_LIMITS.documentBytes) {
    return {
      ok: false,
      issues: [
        { path: '', message: `页面数据过大（上限 ${DECOR_LIMITS.documentBytes / 1024} KB）` },
      ],
    };
  }

  const issues: DocumentIssue[] = [];
  const warnings: DocumentIssue[] = [];
  const unknownBlocks: string[] = [];

  const root = pageRootProps.safeParse(envelope.data.root.props);
  if (!root.success) issues.push(...toIssues(root.error, ['root', 'props']));

  const ids = new Set<string>();
  const perType = new Map<string, number>();
  let dataBlocks = 0;
  const blocks = envelope.data.blocks.map((block, index): PageBlock => {
    const at = `blocks.${index}`;
    if (ids.has(block.id)) issues.push({ path: `${at}.id`, message: `块 id 重复：${block.id}` });
    ids.add(block.id);

    const definition = registry.get(block.type);
    if (!definition) {
      unknownBlocks.push(block.type);
      const message = `未知组件「${block.type}」，当前版本无法显示`;
      warnings.push({ path: `${at}.type`, message });
      issues.push({ path: `${at}.type`, message: `${message}，请删除后再发布` });
      return block;
    }
    const count = (perType.get(block.type) ?? 0) + 1;
    perType.set(block.type, count);
    const label = definition.meta.label;
    if (options.kind && !definition.meta.pages.includes(options.kind)) {
      issues.push({
        path: `${at}.type`,
        message: `${DOCUMENT_KINDS[options.kind]}不能使用「${label}」`,
      });
    }
    if (definition.meta.maxPerPage !== undefined && count > definition.meta.maxPerPage) {
      issues.push({
        path: `${at}.type`,
        message: `「${label}」一个页面最多 ${definition.meta.maxPerPage} 个`,
      });
    }

    const migrated = migrateBlockProps(definition, block.v, block.props);
    if (!migrated.ok) {
      if (migrated.reason === 'newer') {
        unknownBlocks.push(block.type);
        const message = `「${label}」的版本 v${block.v} 比当前版本 v${definition.v} 新`;
        warnings.push({ path: `${at}.v`, message });
        issues.push({ path: `${at}.v`, message: `${message}，无法发布` });
      } else {
        issues.push({ path: `${at}.v`, message: `「${label}」升级失败：${migrated.message}` });
      }
      return block;
    }
    const props = definition.props.safeParse(migrated.props);
    if (!props.success) {
      issues.push(...toIssues(props.error, ['blocks', index, 'props']));
      return { ...block, v: definition.v, props: migrated.props };
    }
    if (definition.data) dataBlocks += 1;
    return { ...block, v: definition.v, props: props.data as Record<string, unknown> };
  });

  if (dataBlocks > DECOR_LIMITS.dataBlocks) {
    issues.push({
      path: 'blocks',
      message: `需要加载数据的组件最多 ${DECOR_LIMITS.dataBlocks} 个（当前 ${dataBlocks} 个）`,
    });
  }

  const document: StoredDocument = {
    schemaVersion: 2,
    root: { props: root.success ? root.data : envelope.data.root.props },
    blocks,
  };
  return { ok: true, document, issues, warnings, unknownBlocks };
}

// ---------------------------------------------------------------------------
// finding links and data sources in a document
// ---------------------------------------------------------------------------

export interface CollectedField {
  /** Dotted path, as in `DocumentIssue`. */
  path: string;
  kind: EditorFieldKind;
  value: unknown;
}

function walk(
  schema: z.ZodType,
  value: unknown,
  path: string,
  kinds: ReadonlySet<EditorFieldKind>,
  out: CollectedField[],
): void {
  if (value === undefined || value === null) return;
  const { schema: inner, meta } = unwrapSchema(schema);
  if (meta?.field && kinds.has(meta.field)) {
    out.push({ path, kind: meta.field, value });
    return;
  }
  const def = inner._zod.def as {
    type: string;
    shape?: Record<string, z.ZodType>;
    element?: z.ZodType;
    options?: z.ZodType[];
  };
  const join = (key: string | number) => (path === '' ? String(key) : `${path}.${key}`);
  if (def.type === 'object' && def.shape && typeof value === 'object') {
    for (const [key, child] of Object.entries(def.shape)) {
      walk(child, (value as Record<string, unknown>)[key], join(key), kinds, out);
    }
  } else if (def.type === 'array' && def.element && Array.isArray(value)) {
    value.forEach((item, index) => walk(def.element as z.ZodType, item, join(index), kinds, out));
  } else if (def.type === 'union' && def.options) {
    const match = def.options.find((option) => option.safeParse(value).success);
    if (match) walk(match, value, path, kinds, out);
  }
}

/**
 * Every value in `props` whose schema carries one of `kinds` as its
 * `meta.field` (convention 3 in `meta.ts`): the links and data sources of a
 * block, found without the server knowing any block by name.
 */
export function collectFields(
  schema: z.ZodType,
  props: unknown,
  kinds: readonly EditorFieldKind[],
  prefix = '',
): CollectedField[] {
  const out: CollectedField[] = [];
  walk(schema, props, prefix, new Set(kinds), out);
  return out;
}

/** The record kinds a document can point at. */
export type ReferenceKind =
  | 'product'
  | 'productCategory'
  | 'productLabel'
  | 'article'
  | 'articleCategory'
  | 'page'
  | 'coupon'
  | 'groupbuy'
  | 'presale';

export interface Reference {
  kind: ReferenceKind;
  id: string;
  path: string;
}

const REFERENCE_FIELDS: readonly EditorFieldKind[] = [
  'link',
  'productSource',
  'couponSource',
  'groupbuySource',
  'presaleSource',
  'articleSource',
];

type Source = { mode: string; ids?: string[]; categoryId?: string; labelId?: string };

function referencesOf(field: CollectedField): Reference[] {
  const path = field.path;
  if (field.kind === 'link') {
    const link = field.value as {
      kind: string;
      id?: string;
      to?: { route: string; params: Record<string, unknown> };
    };
    const byKind: Record<string, ReferenceKind> = {
      product: 'product',
      category: 'productCategory',
      article: 'article',
      page: 'page',
    };
    const kind = byKind[link.kind];
    if (kind && link.id) return [{ kind, id: link.id, path }];
    return [];
  }
  const source = field.value as Source;
  const record: Record<string, ReferenceKind> = {
    productSource: 'product',
    couponSource: 'coupon',
    groupbuySource: 'groupbuy',
    presaleSource: 'presale',
    articleSource: 'article',
  };
  const kind = record[field.kind];
  if (!kind) return [];
  if (source.mode === 'manual') {
    return (source.ids ?? []).map((id, index) => ({ kind, id, path: `${path}.ids.${index}` }));
  }
  if (source.categoryId) {
    const categoryKind = field.kind === 'articleSource' ? 'articleCategory' : 'productCategory';
    return [{ kind: categoryKind, id: source.categoryId, path: `${path}.categoryId` }];
  }
  if (source.labelId)
    return [{ kind: 'productLabel', id: source.labelId, path: `${path}.labelId` }];
  return [];
}

/**
 * Every record a (checked) document points at, by its links and data sources,
 * for the server to confirm they exist. Blocks of unknown type, and blocks
 * whose props did not parse, are skipped: they are already issues.
 */
export function collectReferences(
  document: StoredDocument,
  registry: BlockRegistry = decorBlocks,
): Reference[] {
  const out: Reference[] = [];
  document.blocks.forEach((block, index) => {
    const definition = registry.get(block.type);
    if (!definition || block.v !== definition.v) return;
    if (!definition.props.safeParse(block.props).success) return;
    for (const field of collectFields(
      definition.props,
      block.props,
      REFERENCE_FIELDS,
      `blocks.${index}.props`,
    )) {
      out.push(...referencesOf(field));
    }
  });
  return out;
}
