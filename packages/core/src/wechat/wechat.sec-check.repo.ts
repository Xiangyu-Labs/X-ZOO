import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '@shop/db';
import { contentSecurityChecks, type ContentSecurityCheck } from '@shop/db/schema/wechat';
import { conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/** The `content_security_checks` rows behind `wechat.sec-check.ts` (C09). */

export type { ContentSecurityCheck };
export type MediaCheckSubject = ContentSecurityCheck['subject'];
export type MediaCheckVerdict = 'pass' | 'review' | 'risky';

export async function insertMediaCheck(
  db: DbOrTx,
  values: {
    subject: MediaCheckSubject;
    subjectId: number;
    userId: number | null;
    mediaUrl: string;
    scene: number;
  },
): Promise<number> {
  const [row] = await db
    .insert(contentSecurityChecks)
    .values(values)
    .returning({ id: contentSecurityChecks.id });
  return row!.id;
}

export async function findMediaCheck(db: DbOrTx, id: number): Promise<ContentSecurityCheck | null> {
  const [row] = await db
    .select()
    .from(contentSecurityChecks)
    .where(eq(contentSecurityChecks.id, id))
    .limit(1);
  return row ?? null;
}

export async function findMediaCheckByTrace(
  db: DbOrTx,
  traceId: string,
): Promise<ContentSecurityCheck | null> {
  const [row] = await db
    .select()
    .from(contentSecurityChecks)
    .where(eq(contentSecurityChecks.traceId, traceId))
    .limit(1);
  return row ?? null;
}

/** `pending` → `skipped`; a row already past `pending` is left alone. */
export async function markMediaCheckSkipped(
  db: DbOrTx,
  id: number,
  now: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, contentSecurityChecks, {
    where: and(eq(contentSecurityChecks.id, id), eq(contentSecurityChecks.status, 'pending')),
    set: { status: 'skipped', updatedAt: now },
  });
}

/** `pending` → `submitted`, with the trace id WeChat will answer under. */
export async function markMediaCheckSubmitted(
  db: DbOrTx,
  input: { id: number; traceId: string; now: Date },
): Promise<void> {
  await conditionalUpdate(db, contentSecurityChecks, {
    where: and(eq(contentSecurityChecks.id, input.id), eq(contentSecurityChecks.status, 'pending')),
    set: {
      status: 'submitted',
      traceId: input.traceId,
      submittedAt: input.now,
      updatedAt: input.now,
    },
  });
}

/** `submitted` → the verdict. `won` is false for a verdict that was already recorded. */
export async function decideMediaCheck(
  db: DbOrTx,
  input: { id: number; verdict: MediaCheckVerdict; label: number | null; now: Date },
): Promise<{ won: boolean }> {
  const result = await conditionalUpdate(db, contentSecurityChecks, {
    where: and(
      eq(contentSecurityChecks.id, input.id),
      eq(contentSecurityChecks.status, 'submitted'),
    ),
    set: { status: input.verdict, label: input.label, resolvedAt: input.now, updatedAt: input.now },
  });
  return { won: result.won };
}

export async function setMediaCheckAction(
  db: DbOrTx,
  input: { id: number; action: string; now: Date },
): Promise<void> {
  await db
    .update(contentSecurityChecks)
    .set({ action: input.action, updatedAt: input.now })
    .where(eq(contentSecurityChecks.id, input.id));
}

export async function listMediaChecks(
  db: DbOrTx,
  subject: MediaCheckSubject,
  subjectId: number,
): Promise<ContentSecurityCheck[]> {
  return db
    .select()
    .from(contentSecurityChecks)
    .where(
      and(
        eq(contentSecurityChecks.subject, subject),
        eq(contentSecurityChecks.subjectId, subjectId),
      ),
    )
    .orderBy(contentSecurityChecks.id);
}
