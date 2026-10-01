import type { Data } from '@puckeditor/core';
import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import { pageRootProps, type StoredDocument } from '@shop/contracts/decor/document';
import { migrateBlockProps, type BlockRegistry } from '@shop/contracts/decor/registry';

import { GROUP_FIELD_PREFIX, defaultsOf } from './zod-to-puck';

/**
 * The DIY v2 page document ⇄ the editor's own data.
 *
 * The document is what is stored and what the storefront renders
 * (`{schemaVersion: 2, root: {props}, blocks: [{id, type, v, props}]}`); Puck's
 * `Data` is an editor detail and never leaves the admin. Keeping the
 * conversion in one place is what makes the editor replaceable.
 *
 * Differences it absorbs:
 *
 * - Puck keeps a block's `id` inside `props`; the document keeps it beside them.
 * - Puck has no block version. A block stored at an older version is migrated
 *   on the way in (the contracts' `migrate` steps, the same the server runs),
 *   and the current version is written on the way out.
 * - A block this build cannot edit — an unknown type, a version newer than
 *   this build's, a migration that fails — is carried through untouched as an
 *   `UNKNOWN_BLOCK` item: it keeps its place, can be moved or deleted, and is
 *   written back exactly as it came. The server reports it as an issue, so
 *   such a page can be saved but not published (DECOR-003).
 * - Puck's `zones` (drop zones inside a block) have no document equivalent:
 *   an empty map is dropped, a non-empty one is an error.
 * - The inspector's group headings are pseudo fields (`GROUP_FIELD_PREFIX`);
 *   a stray value under one never reaches the document.
 */

export class DecorConversionError extends Error {
  override name = 'DecorConversionError';
}

/** The editor-only component that holds a block this build cannot edit. */
export const UNKNOWN_BLOCK = '__unknown';

export interface UnknownBlockProps {
  id: string;
  /** The stored block, exactly as it came. */
  block: StoredDocument['blocks'][number];
  /** Why it cannot be edited, for the canvas notice. */
  reason: string;
}

type PuckContentItem = Data['content'][number];

function withoutEditorKeys(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => !key.startsWith(GROUP_FIELD_PREFIX)),
  );
}

/**
 * Document → Puck data, for opening a draft or a revision. Root props are
 * filled from the schema's defaults where the stored draft has none.
 */
export function toPuckData(document: StoredDocument, registry: BlockRegistry = decorBlocks): Data {
  const rootDefaults = defaultsOf(pageRootProps) as Record<string, unknown>;
  return {
    root: { props: { ...rootDefaults, ...document.root.props } },
    content: document.blocks.map((block): PuckContentItem => {
      const unknown = (reason: string): PuckContentItem => ({
        type: UNKNOWN_BLOCK,
        props: { id: block.id, block, reason } satisfies UnknownBlockProps,
      });
      const definition = registry.get(block.type);
      if (!definition) return unknown(`当前后台不认识组件「${block.type}」`);
      const migrated = migrateBlockProps(definition, block.v, block.props);
      if (!migrated.ok) {
        return unknown(
          migrated.reason === 'newer'
            ? `「${definition.meta.label}」的版本 v${block.v} 比当前后台的 v${definition.v} 新`
            : `「${definition.meta.label}」无法升级：${migrated.message}`,
        );
      }
      return { type: block.type, props: { ...migrated.props, id: block.id } };
    }),
  };
}

/**
 * Puck data → document, for saving and previewing. The props are carried
 * over as they are; the server's `checkDocument` is what checks them.
 */
export function toPageDocument(data: Data, registry: BlockRegistry = decorBlocks): StoredDocument {
  const zones = Object.entries(data.zones ?? {}).filter(([, items]) => items.length > 0);
  if (zones.length > 0) {
    throw new DecorConversionError(
      `页面文档不支持嵌套区域：${zones.map(([key]) => key).join('、')}`,
    );
  }
  const root = data.root as { props?: Record<string, unknown> };
  return {
    schemaVersion: 2,
    root: { props: withoutEditorKeys(root.props ?? {}) },
    blocks: data.content.map((item) => {
      if (item.type === UNKNOWN_BLOCK) return (item.props as unknown as UnknownBlockProps).block;
      const definition = registry.get(item.type);
      if (!definition) throw new DecorConversionError(`未知的块类型「${item.type}」`);
      const { id, ...props } = item.props as { id: string } & Record<string, unknown>;
      return { id, type: item.type, v: definition.v, props: withoutEditorKeys(props) };
    }),
  };
}

/**
 * A key-order-independent serialisation, for telling whether the editor's
 * document differs from the one last saved. Puck may hand back the same props
 * with their keys in another order, or with an `undefined` it added; neither
 * is an edit.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return inner;
  });
}
