import { z } from 'zod';

import { id, instant, pageQuery, paged } from '../_conventions/common';
import { DESIGNATIONS, DOCUMENT_KINDS, type Designation, type DocumentKind } from './constants';
import { documentIssue, pageDocument, pageDocumentEnvelope } from './document';
import { personalSlot, resolvedSlot } from './sources';

/** Wire schemas of the decor routes. The document model itself is in `document.ts`. */

export const documentKind = z.enum(
  Object.keys(DOCUMENT_KINDS) as [DocumentKind, ...DocumentKind[]],
);
export const designation = z.enum(Object.keys(DESIGNATIONS) as [Designation, ...Designation[]]);

/**
 * The draft's optimistic-lock token. Opaque: send back exactly what the last
 * read or save returned.
 */
export const draftVersion = z.string().regex(/^[1-9]\d{0,9}$/, '版本号格式不正确');

export const documentName = z.string().trim().min(1, '请填写页面名称').max(50);
export const revisionNote = z.string().trim().max(200);

export const revisionSummary = z.object({
  id,
  number: z.number().int().min(1),
  note: z.string(),
  authorAdminId: id.nullable(),
  /** Set on a rollback: the revision number whose content was republished. */
  restoredFrom: z.number().int().min(1).nullable(),
  createdAt: instant,
});
export type RevisionSummary = z.infer<typeof revisionSummary>;

export const revisionDetail = revisionSummary.extend({ content: pageDocument });
export type RevisionDetail = z.infer<typeof revisionDetail>;

export const decorDocumentSummary = z.object({
  id,
  kind: documentKind,
  name: z.string(),
  /** The draft's page title (`root.props.title`). */
  title: z.string(),
  /** What this document is serving as, if anything. */
  designation: designation.nullable(),
  draftVersion,
  /** The live revision, if the document was ever published. */
  published: revisionSummary.nullable(),
  /** The draft differs from what is live (or nothing is live yet). */
  hasUnpublishedChanges: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
});
export type DecorDocumentSummary = z.infer<typeof decorDocumentSummary>;

export const decorDocumentDetail = decorDocumentSummary.extend({
  draft: pageDocumentEnvelope,
  /** What still blocks publishing the draft, computed on read. */
  issues: z.array(documentIssue),
  /** Worth showing, never blocking (unknown block types, records that no longer exist). */
  warnings: z.array(documentIssue),
});
export type DecorDocumentDetail = z.infer<typeof decorDocumentDetail>;

export const decorDocumentListQuery = pageQuery.extend({
  kind: documentKind.optional(),
  keyword: z.string().trim().max(50).optional(),
});
export type DecorDocumentListQuery = z.infer<typeof decorDocumentListQuery>;

export const pagedDecorDocuments = paged(decorDocumentSummary);

export const createDecorDocumentBody = z.object({
  kind: documentKind,
  name: documentName,
  /** Initial draft. Omitted: an empty page titled after `name`. */
  document: pageDocumentEnvelope.optional(),
});
export type CreateDecorDocumentBody = z.infer<typeof createDecorDocumentBody>;

export const renameDecorDocumentBody = z.object({ name: documentName });

export const duplicateDecorDocumentBody = z.object({
  /** Omitted: `<name> 副本`. */
  name: documentName.optional(),
});

export const saveDraftBody = z.object({
  document: pageDocumentEnvelope,
  /** The token the editor loaded. A stale token fails with `DECOR_VERSION_CONFLICT`. */
  version: draftVersion,
});
export type SaveDraftBody = z.infer<typeof saveDraftBody>;

export const saveDraftResponse = z.object({
  /** The new token, for the next save. */
  version: draftVersion,
  issues: z.array(documentIssue),
  warnings: z.array(documentIssue),
  updatedAt: instant,
});
export type SaveDraftResponse = z.infer<typeof saveDraftResponse>;

export const publishBody = z.object({
  /** The draft token the operator is looking at; publishing fails if the draft moved on. */
  version: draftVersion.optional(),
  note: revisionNote.default(''),
});
export type PublishBody = z.infer<typeof publishBody>;

export const rollbackBody = z.object({ note: revisionNote.default('') });

export const publishResponse = z.object({
  document: decorDocumentSummary,
  revision: revisionSummary,
  warnings: z.array(documentIssue),
});
export type PublishResponse = z.infer<typeof publishResponse>;

export const revisionParams = z.object({
  id,
  number: z.coerce.number().int().min(1).max(2_147_483_647),
});

export const designationParams = z.object({ designation });

export const designateBody = z.object({
  /** The document to serve; `null` clears the designation (个人中心 falls back to the built-in page). */
  documentId: id.nullable(),
});

export const designationsResponse = z.object({
  home: decorDocumentSummary.nullable(),
  user_center: decorDocumentSummary.nullable(),
});
export type DesignationsResponse = z.infer<typeof designationsResponse>;

export const previewTokenResponse = z.object({
  /**
   * Pass as `?previewToken=` to `GET /api/v1/pages/:id`. Read-only, this
   * document's draft only. (Not named `token`: the secrets guard reserves it.)
   */
  previewToken: z.string(),
  expiresAt: instant,
});
export type PreviewTokenResponse = z.infer<typeof previewTokenResponse>;

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

export const resolvedBlock = z.object({
  id: z.string(),
  type: z.string(),
  v: z.number().int().positive(),
  props: z.record(z.string(), z.unknown()),
  /**
   * The block's data, by the slot names its definition declares; `{}` for a
   * block that needs none. A slot is `null` when its data could not be loaded
   * this time: render the block without it.
   */
  data: z.record(z.string(), resolvedSlot.nullable()),
});
export type ResolvedBlock = z.infer<typeof resolvedBlock>;

/**
 * Root props as the storefront receives them: `pageRootProps` with every
 * default already applied, so the client's type has no optional-by-default
 * fields (a response schema's input and output must agree).
 */
export const servedRootProps = z.object({
  title: z.string(),
  background: z.string(),
  shareEnabled: z.boolean(),
  shareTitle: z.string(),
  shareImage: z.string().optional(),
});

export const resolvedPage = z.object({
  /** `null` for the built-in 个人中心. */
  id: id.nullable(),
  kind: documentKind,
  /** The revision served; `null` for a preview (the draft) and for the built-in page. */
  revision: z.number().int().min(1).nullable(),
  preview: z.boolean(),
  root: z.object({ props: servedRootProps }),
  /** Only the blocks this client and this shopper should see, in page order. */
  blocks: z.array(resolvedBlock),
  /**
   * Per-shopper state by block id, then slot — only with a session, never
   * cached. `null` without one.
   */
  personal: z.record(z.string(), z.record(z.string(), personalSlot)).nullable(),
  /** Changes when the page's layout changes (a publish), not when its data does. */
  version: z.string(),
  resolvedAt: instant,
});
export type ResolvedPage = z.infer<typeof resolvedPage>;

export const pageResolveQuery = z.object({
  previewToken: z.string().min(16).max(128).optional(),
});
