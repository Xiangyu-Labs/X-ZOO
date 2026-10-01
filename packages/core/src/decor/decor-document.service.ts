import { USER_CENTER_DEFAULT_DOCUMENT } from '@shop/contracts/decor/defaults';
import {
  checkDocument,
  collectReferences,
  type CheckedDocument,
  type DocumentIssue,
  type StoredDocument,
} from '@shop/contracts/decor/document';
import type {
  CreateDecorDocumentBody,
  DecorDocumentDetail,
  DecorDocumentListQuery,
  DecorDocumentSummary,
  DesignationsResponse,
  PublishResponse,
  RevisionDetail,
  RevisionSummary,
  SaveDraftResponse,
} from '@shop/contracts/decor/schemas';
import type { Designation, DocumentKind } from '@shop/contracts/decor/constants';

import { anonymousActor, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { dropCachedPage } from './decor.cache';
import { issuePreviewToken } from './decor.preview';
import { referenceWarnings } from './decor.references';
import * as repo from './decor.repo';

/**
 * 页面装修 v2 — the admin side: documents, drafts, revisions, designations.
 *
 * The rules, each with its invariant in `docs/invariants.md`:
 *
 * - a draft save is optimistically locked on `draftVersion` (DECOR-010);
 * - a draft that fails the envelope is refused, content issues are saved and
 *   reported (DECOR-003);
 * - publishing is atomic: a new revision and the live pointer, or neither, and
 *   only a draft with no issues (DECOR-007);
 * - revisions are append-only; a rollback republishes old content as a new
 *   revision (DECOR-006, DECOR-011);
 * - one designated 首页 and one 个人中心, each a published document of the
 *   matching kind (DECOR-008);
 * - a designated document cannot be deleted (DECOR-009).
 */

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

function toRevisionSummary(row: Omit<repo.RevisionRow, 'content'>): RevisionSummary {
  return {
    id: String(row.id),
    number: row.number,
    note: row.note,
    authorAdminId: row.authorAdminId === null ? null : String(row.authorAdminId),
    restoredFrom: row.restoredFrom,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSummary({ document, live }: repo.DocumentWithLive): DecorDocumentSummary {
  return {
    id: String(document.id),
    kind: document.kind,
    name: document.name,
    title: document.title,
    designation: document.designation,
    draftVersion: String(document.draftVersion),
    published: live ? toRevisionSummary(live) : null,
    hasUnpublishedChanges:
      document.publishedRevisionId === null ||
      document.publishedDraftVersion !== document.draftVersion,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function titleOf(document: StoredDocument): string {
  const title = document.root.props.title;
  return typeof title === 'string' ? [...title].slice(0, 30).join('') : '';
}

function adminIdOf(ctx: Ctx): number | null {
  return ctx.actor.kind === 'admin' ? ctx.actor.id : null;
}

/** Checks a draft; a broken envelope is `DECOR_DOCUMENT_INVALID`, nothing else throws. */
function checkDraft(input: unknown, kind: DocumentKind): CheckedDocument {
  const result = checkDocument(input, { kind });
  if (!result.ok)
    throw new DomainError('DECOR_DOCUMENT_INVALID', { details: { issues: result.issues } });
  return result;
}

/** Warnings for a checked document: its own plus every record a shopper could not see. */
async function warningsOf(ctx: Ctx, checked: CheckedDocument): Promise<DocumentIssue[]> {
  const references = await referenceWarnings(
    ctx.as(anonymousActor),
    collectReferences(checked.document),
  );
  return [...checked.warnings, ...references];
}

async function load(ctx: Ctx, id: string): Promise<repo.DocumentWithLive> {
  const row = await repo.findDocument(ctx.db, Number(id));
  if (!row) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
  return row;
}

async function detailOf(ctx: Ctx, row: repo.DocumentWithLive): Promise<DecorDocumentDetail> {
  const draft = row.document.draft;
  const checked = checkDocument(draft, { kind: row.document.kind });
  return {
    ...toSummary(row),
    // The draft as this build reads it: a block stored at an older version
    // comes back migrated (DECOR-003), so the editor opens a draft saved
    // before a block's upgrade. It is stored migrated on the next save.
    draft: checked.ok ? (checked.document as StoredDocument) : (draft as StoredDocument),
    issues: checked.issues,
    warnings: checked.ok ? await warningsOf(ctx, checked) : [],
  };
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

export async function listDocuments(
  ctx: Ctx,
  query: DecorDocumentListQuery,
): Promise<{ items: DecorDocumentSummary[]; total: number; page: number; pageSize: number }> {
  const { items, total } = await repo.listDocuments(ctx.db, {
    kind: query.kind,
    keyword: query.keyword,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { items: items.map(toSummary), total, page: query.page, pageSize: query.pageSize };
}

export async function getDocument(ctx: Ctx, input: { id: string }): Promise<DecorDocumentDetail> {
  return detailOf(ctx, await load(ctx, input.id));
}

function emptyDocument(kind: DocumentKind, name: string): StoredDocument {
  // A new 个人中心 starts from the built-in one the storefront shows until one
  // is designated, so the operator edits what shoppers already see.
  if (kind === 'user_center') return structuredClone(USER_CENTER_DEFAULT_DOCUMENT);
  return {
    schemaVersion: 2,
    root: {
      props: {
        title: [...name].slice(0, 30).join(''),
        background: '#f5f5f5',
        shareEnabled: true,
        shareTitle: '',
      },
    },
    blocks: [],
  };
}

export async function createDocument(
  ctx: Ctx,
  input: CreateDecorDocumentBody,
): Promise<DecorDocumentDetail> {
  const checked = checkDraft(input.document ?? emptyDocument(input.kind, input.name), input.kind);
  const row = await repo.insertDocument(ctx.db, {
    kind: input.kind,
    name: input.name,
    title: titleOf(checked.document),
    draft: checked.document,
    createdByAdminId: adminIdOf(ctx),
    now: ctx.clock.now(),
  });
  return detailOf(ctx, { document: row, live: null });
}

export async function renameDocument(
  ctx: Ctx,
  input: { id: string; name: string },
): Promise<DecorDocumentSummary> {
  const ok = await repo.renameDocument(ctx.db, Number(input.id), input.name, ctx.clock.now());
  if (!ok) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
  return toSummary(await load(ctx, input.id));
}

/** Copies the draft into a new document: unpublished, undesignated, same kind. */
export async function duplicateDocument(
  ctx: Ctx,
  input: { id: string; name?: string | undefined },
): Promise<DecorDocumentDetail> {
  const source = await load(ctx, input.id);
  const name = input.name ?? [...`${source.document.name} 副本`].slice(0, 50).join('');
  const row = await repo.insertDocument(ctx.db, {
    kind: source.document.kind,
    name,
    title: source.document.title,
    draft: source.document.draft,
    createdByAdminId: adminIdOf(ctx),
    now: ctx.clock.now(),
  });
  return detailOf(ctx, { document: row, live: null });
}

/** Soft delete; refused for the designated 首页 / 个人中心 (DECOR-009). */
export async function deleteDocument(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  if (await repo.softDeleteUndesignated(ctx.db, id, ctx.clock.now())) return;
  // The conditional write did nothing: say why.
  const row = await repo.findDocument(ctx.db, id);
  if (!row) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
  throw new DomainError('DECOR_DOCUMENT_IN_USE');
}

// ---------------------------------------------------------------------------
// the draft
// ---------------------------------------------------------------------------

/**
 * Saves the draft, guarded on the version the editor loaded (DECOR-010).
 *
 * The envelope must check; content issues are stored and returned (the
 * operator's half-finished work is never thrown away), and block publishing.
 */
export async function saveDraft(
  ctx: Ctx,
  input: { id: string; document: unknown; version: string },
): Promise<SaveDraftResponse> {
  const id = Number(input.id);
  const current = await repo.findDocument(ctx.db, id);
  if (!current) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
  const checked = checkDraft(input.document, current.document.kind);
  const saved = await repo.saveDraft(ctx.db, {
    id,
    expectedVersion: Number(input.version),
    draft: checked.document,
    title: titleOf(checked.document),
    now: ctx.clock.now(),
  });
  if (!saved) {
    const now = await repo.findDocument(ctx.db, id);
    if (!now) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
    throw new DomainError('DECOR_VERSION_CONFLICT', {
      details: { version: String(now.document.draftVersion) },
    });
  }
  return {
    version: String(saved.draftVersion),
    issues: checked.issues,
    warnings: await warningsOf(ctx, checked),
    updatedAt: saved.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// publishing
// ---------------------------------------------------------------------------

/**
 * Publishes the draft (DECOR-007): one transaction that row-locks the
 * document, re-reads the draft, checks it strictly, numbers and inserts the
 * revision, and moves the live pointer. Either all of it happens or none.
 *
 * - `version`, when given, must still be the draft's: the operator publishes
 *   what they are looking at, not a colleague's later save.
 * - A draft already live is `DECOR_NOTHING_TO_PUBLISH`, so a double click (or
 *   two operators) yields one revision, not two identical ones.
 */
export async function publish(
  ctx: Ctx,
  input: { id: string; version?: string | undefined; note: string },
): Promise<PublishResponse> {
  const id = Number(input.id);
  const now = ctx.clock.now();
  const outcome = await ctx.withTx(async (tx) => {
    const document = await repo.lockDocument(tx, id);
    if (!document) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
    if (input.version !== undefined && Number(input.version) !== document.draftVersion) {
      throw new DomainError('DECOR_VERSION_CONFLICT', {
        details: { version: String(document.draftVersion) },
      });
    }
    if (
      document.publishedRevisionId !== null &&
      document.publishedDraftVersion === document.draftVersion
    ) {
      throw new DomainError('DECOR_NOTHING_TO_PUBLISH');
    }
    const checked = checkDocument(document.draft, { kind: document.kind });
    if (!checked.ok || checked.issues.length > 0) {
      throw new DomainError('DECOR_DOCUMENT_INVALID', { details: { issues: checked.issues } });
    }
    const revision = await repo.insertRevision(tx, {
      documentId: id,
      number: await repo.nextRevisionNumber(tx, id),
      content: checked.document,
      authorAdminId: adminIdOf(ctx),
      note: input.note,
      restoredFrom: null,
      now,
    });
    await repo.setLive(tx, {
      id,
      revisionId: revision.id,
      publishedDraftVersion: document.draftVersion,
      now,
    });
    return { previous: document.publishedRevisionId, revision, checked };
  });
  await dropCachedPage(ctx, outcome.previous);
  return {
    document: toSummary(await load(ctx, input.id)),
    revision: toRevisionSummary(outcome.revision),
    warnings: await warningsOf(ctx, outcome.checked),
  };
}

export async function listRevisions(
  ctx: Ctx,
  input: { id: string },
): Promise<{ items: RevisionSummary[] }> {
  const row = await load(ctx, input.id);
  const rows = await repo.listRevisions(ctx.db, row.document.id);
  return { items: rows.map(toRevisionSummary) };
}

export async function getRevision(
  ctx: Ctx,
  input: { id: string; number: number },
): Promise<RevisionDetail> {
  const row = await load(ctx, input.id);
  const revision = await repo.findRevisionByNumber(ctx.db, row.document.id, input.number);
  if (!revision) throw new DomainError('DECOR_REVISION_NOT_FOUND');
  return { ...toRevisionSummary(revision), content: revision.content as RevisionDetail['content'] };
}

/**
 * Rolls back (DECOR-011): the old revision's content is published again as a
 * *new* revision with `restoredFrom` set. Nothing is rewritten, and the draft
 * is left as it is — so the document now shows unpublished changes, and the
 * operator decides whether to load the restored content into the editor.
 *
 * The content is checked against this build, as any publish is: a revision
 * holding a block type since removed cannot go live again.
 */
export async function rollback(
  ctx: Ctx,
  input: { id: string; number: number; note: string },
): Promise<PublishResponse> {
  const id = Number(input.id);
  const now = ctx.clock.now();
  const outcome = await ctx.withTx(async (tx) => {
    const document = await repo.lockDocument(tx, id);
    if (!document) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
    const source = await repo.findRevisionByNumber(tx, id, input.number);
    if (!source) throw new DomainError('DECOR_REVISION_NOT_FOUND');
    const checked = checkDocument(source.content, { kind: document.kind });
    if (!checked.ok || checked.issues.length > 0) {
      throw new DomainError('DECOR_DOCUMENT_INVALID', { details: { issues: checked.issues } });
    }
    const revision = await repo.insertRevision(tx, {
      documentId: id,
      number: await repo.nextRevisionNumber(tx, id),
      content: checked.document,
      authorAdminId: adminIdOf(ctx),
      note: input.note,
      restoredFrom: source.number,
      now,
    });
    await repo.setLive(tx, { id, revisionId: revision.id, publishedDraftVersion: null, now });
    return { previous: document.publishedRevisionId, revision, checked };
  });
  await dropCachedPage(ctx, outcome.previous);
  return {
    document: toSummary(await load(ctx, input.id)),
    revision: toRevisionSummary(outcome.revision),
    warnings: await warningsOf(ctx, outcome.checked),
  };
}

// ---------------------------------------------------------------------------
// designations
// ---------------------------------------------------------------------------

export async function getDesignations(ctx: Ctx): Promise<DesignationsResponse> {
  const [home, userCenter] = await Promise.all([
    repo.findDesignated(ctx.db, 'home'),
    repo.findDesignated(ctx.db, 'user_center'),
  ]);
  return {
    home: home ? toSummary(home) : null,
    user_center: userCenter ? toSummary(userCenter) : null,
  };
}

/**
 * Makes `documentId` the 首页 / 个人中心, or clears it (DECOR-008). Under an
 * advisory lock per designation, so concurrent switches queue up; the
 * document is row-locked so it cannot be deleted in between.
 */
export async function designate(
  ctx: Ctx,
  input: { designation: Designation; documentId: string | null },
): Promise<DesignationsResponse> {
  const now = ctx.clock.now();
  await ctx.withTx(async (tx) => {
    await repo.lockDesignation(tx, input.designation);
    if (input.documentId === null) {
      await repo.clearDesignation(tx, input.designation, null, now);
      return;
    }
    const id = Number(input.documentId);
    const document = await repo.lockDocument(tx, id);
    if (!document) throw new DomainError('DECOR_DOCUMENT_NOT_FOUND');
    if (document.kind !== input.designation) throw new DomainError('DECOR_KIND_MISMATCH');
    if (document.publishedRevisionId === null) throw new DomainError('DECOR_NOT_PUBLISHED');
    await repo.clearDesignation(tx, input.designation, id, now);
    if (document.designation !== input.designation) {
      await repo.setDesignation(tx, id, input.designation, now);
    }
  });
  return getDesignations(ctx);
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

export async function createPreviewToken(
  ctx: Ctx,
  input: { id: string },
): Promise<{ previewToken: string; expiresAt: string }> {
  const row = await load(ctx, input.id);
  return issuePreviewToken(ctx, row.document.id);
}
