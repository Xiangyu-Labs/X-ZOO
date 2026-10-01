import type { Data } from '@puckeditor/core';
import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import { DESIGNATIONS, DOCUMENT_KINDS, type DocumentKind } from '@shop/contracts/decor/constants';
import type { DocumentIssue, StoredDocument } from '@shop/contracts/decor/document';
import type { BlockRegistry } from '@shop/contracts/decor/registry';
import type { DecorDocumentSummary } from '@shop/contracts/decor/schemas';

import { ApiError } from '../api';
import type { StatusMap } from '../kit';
import { canonicalJson, toPageDocument } from './document';

/**
 * The editor page's pure parts: labels, what "unsaved" means, how a failed
 * save or publish is told apart, where an issue points and the preview URL.
 * Kept out of the components so they can be tested without a canvas.
 */

export const KIND_LABELS: StatusMap<DocumentKind> = {
  home: { label: DOCUMENT_KINDS.home, color: 'blue' },
  user_center: { label: DOCUMENT_KINDS.user_center, color: 'cyan' },
  custom: { label: DOCUMENT_KINDS.custom, color: 'default' },
};

export const DESIGNATION_LABELS: StatusMap<NonNullable<DecorDocumentSummary['designation']>> = {
  home: { label: DESIGNATIONS.home, color: 'blue' },
  user_center: { label: DESIGNATIONS.user_center, color: 'cyan' },
};

// ─── unsaved changes ─────────────────────────────────────────────────────────

export type Snapshot =
  { ok: true; document: StoredDocument; json: string } | { ok: false; error: string };

/** The editor's data as the document a save would send, and its comparison key. */
export function snapshotOf(data: Data, registry: BlockRegistry = decorBlocks): Snapshot {
  try {
    const document = toPageDocument(data, registry);
    return { ok: true, document, json: canonicalJson(document) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether the editor holds something the last save did not store. A snapshot
 * that cannot even be converted is unsaved by definition: leaving would lose it.
 */
export function isDirty(snapshot: Snapshot, savedJson: string): boolean {
  return !snapshot.ok || snapshot.json !== savedJson;
}

// ─── failed saves and publishes ──────────────────────────────────────────────

export type DecorFailure =
  /** Someone else saved the draft; `version` is theirs, for an overwrite. */
  | { kind: 'conflict'; version: string | undefined }
  /** The document does not check; `issues` say where. */
  | { kind: 'invalid'; issues: DocumentIssue[] }
  | { kind: 'nothing-to-publish' }
  | { kind: 'other'; error: unknown };

function issuesOf(details: unknown): DocumentIssue[] {
  const issues = (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is DocumentIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as DocumentIssue).path === 'string' &&
      typeof (issue as DocumentIssue).message === 'string',
  );
}

export function classifyFailure(error: unknown): DecorFailure {
  if (!ApiError.is(error)) return { kind: 'other', error };
  switch (error.code) {
    case 'DECOR_VERSION_CONFLICT': {
      const version = (error.details as { version?: unknown } | undefined)?.version;
      return { kind: 'conflict', version: typeof version === 'string' ? version : undefined };
    }
    case 'DECOR_DOCUMENT_INVALID':
      return { kind: 'invalid', issues: issuesOf(error.details) };
    case 'DECOR_NOTHING_TO_PUBLISH':
      return { kind: 'nothing-to-publish' };
    default:
      return { kind: 'other', error };
  }
}

// ─── where an issue points ───────────────────────────────────────────────────

export interface LocatedIssue {
  key: string;
  message: string;
  /** `第 3 个组件「轮播图」`, `页面设置` or `页面`. */
  where: string;
  /** The rest of the path inside the block or the root props, for the curious. */
  field: string | undefined;
  /** The block to select, by id (indexes move as the operator edits). */
  blockId: string | undefined;
  /** Points at the root props: select nothing, and the page settings show. */
  root: boolean;
}

/**
 * Issues come back as dotted paths into the document that was sent
 * (`blocks.2.props.slides.0.image`). The block index is turned into the
 * block's id and label now, while that document is at hand.
 */
export function locateIssues(
  issues: readonly DocumentIssue[],
  document: StoredDocument,
  registry: BlockRegistry = decorBlocks,
): LocatedIssue[] {
  return issues.map((issue, index) => {
    const key = `${index}:${issue.path}:${issue.message}`;
    const parts = issue.path.split('.');
    if (parts[0] === 'blocks' && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
      const at = Number(parts[1]);
      const block = document.blocks[at];
      const label = block ? (registry.get(block.type)?.meta.label ?? block.type) : undefined;
      const rest = parts.slice(parts[2] === 'props' ? 3 : 2).join('.');
      return {
        key,
        message: issue.message,
        where: `第 ${at + 1} 个组件${label ? `「${label}」` : ''}`,
        field: rest || undefined,
        blockId: block?.id,
        root: false,
      };
    }
    if (parts[0] === 'root') {
      const rest = parts.slice(parts[1] === 'props' ? 2 : 1).join('.');
      return {
        key,
        message: issue.message,
        where: '页面设置',
        field: rest || undefined,
        blockId: undefined,
        root: true,
      };
    }
    return {
      key,
      message: issue.message,
      where: '页面',
      field: issue.path || undefined,
      blockId: undefined,
      root: false,
    };
  });
}

// ─── preview ─────────────────────────────────────────────────────────────────

/** The mini-program page a draft preview opens (`packages/page/index`), as a 体验版 path. */
export function miniPreviewPath(id: string, previewToken: string): string {
  return `packages/page/index?id=${encodeURIComponent(id)}&previewToken=${encodeURIComponent(previewToken)}`;
}

/**
 * The H5 preview URL, from the `DECOR_PREVIEW_URL` template: `{id}`,
 * `{previewToken}` and `{kind}` are replaced, URL-encoded. `null` when no
 * template is configured (production: preview goes through the 体验版).
 */
export function h5PreviewUrl(
  template: string | null | undefined,
  values: { id: string; previewToken: string; kind: DocumentKind },
): string | null {
  if (!template) return null;
  return template.replace(/\{(id|previewToken|kind)\}/g, (_match, name: keyof typeof values) =>
    encodeURIComponent(values[name]),
  );
}
