/**
 * Names the 操作日志 borrows from other domains.
 *
 * `system/audit-labels.ts` turns a row's target into words, and some of those
 * words belong to a domain that itself imports `system` (a notification
 * event's name). Importing that domain back from `system` is a cycle that
 * leaves one side half-loaded, so the domain hands its lookup over here at
 * bootstrap instead. Until it has, the reader falls back to the raw key.
 */
export type AuditNameKind = 'notification-event';

const lookups = new Map<AuditNameKind, (key: string) => string | undefined>();

export function registerAuditNameLookup(
  kind: AuditNameKind,
  lookup: (key: string) => string | undefined,
): void {
  lookups.set(kind, lookup);
}

export function auditName(kind: AuditNameKind, key: string): string | undefined {
  return lookups.get(kind)?.(key);
}
