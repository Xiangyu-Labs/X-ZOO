/**
 * The block prop schemas, the page document and `LinkTarget`.
 *
 * These moved to `@shop/contracts/decor/*` (stream F1; the contracts own the
 * data model, plan §2.1). This entry re-exports them for the editor, under the
 * S3 names it already uses, and lists the block types (`BLOCKS`, `BlockType`)
 * with what the editor needs of each. It carries zod: a client bundle never imports it (the
 * blocks import only types, plus the zod-free `decor/constants` and `decor/rich-text`).
 */
import type { z } from 'zod';

import { DECOR_BLOCK_DEFINITIONS, decorBlocks } from '@shop/contracts/decor/all-blocks';
import {
  checkDocument,
  type DocumentIssue,
  type PageDocument,
} from '@shop/contracts/decor/document';

export * from '@shop/contracts/decor/base';
export * from '@shop/contracts/decor/all-blocks';
export * from '@shop/contracts/decor/constants';
export * from '@shop/contracts/decor/document';
export * from '@shop/contracts/decor/link';
export * from '@shop/contracts/decor/link-route';
export * from '@shop/contracts/decor/meta';
export * from '@shop/contracts/decor/registry';
export * from '@shop/contracts/decor/rich-text';
export * from '@shop/contracts/decor/sources';

type Definition = (typeof DECOR_BLOCK_DEFINITIONS)[number];

/**
 * Every registered block type with its palette label, version and prop
 * schema, in palette order. This package has a component for each
 * (`BLOCK_COMPONENTS` is a `Record` over these keys, so a type added to the
 * contracts does not compile here until it has one).
 */
export const BLOCKS = Object.fromEntries(
  DECOR_BLOCK_DEFINITIONS.map((definition) => [
    definition.type,
    { label: definition.meta.label, v: definition.v, props: definition.props },
  ]),
) as {
  readonly [D in Definition as D['type']]: { label: string; v: number; props: D['props'] };
};

export type BlockType = keyof typeof BLOCKS;

export const BLOCK_TYPES = Object.keys(BLOCKS) as BlockType[];

export function isBlockType(type: string): type is BlockType {
  // Not Object.hasOwn: the mini-program type-checks this file against iOS 12's library.
  return Object.prototype.hasOwnProperty.call(BLOCKS, type);
}

export type BlockPropsOf<T extends BlockType> = z.infer<(typeof BLOCKS)[T]['props']>;

export type ValidatedDocument =
  | { ok: true; document: PageDocument; unknownBlocks: string[] }
  | { ok: false; issues: DocumentIssue[] };

/**
 * The S3 editor's check: `checkDocument` against every registered block type,
 * collapsed to ok / issues, except that an unknown type is tolerated (reported
 * in `unknownBlocks`) rather than an issue.
 */
export function validatePageDocument(input: unknown): ValidatedDocument {
  const result = checkDocument(input, { registry: decorBlocks });
  if (!result.ok) return result;
  const issues = result.issues.filter(
    (issue) => !result.warnings.some((warning) => warning.path === issue.path),
  );
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    document: result.document as PageDocument,
    unknownBlocks: result.unknownBlocks,
  };
}
