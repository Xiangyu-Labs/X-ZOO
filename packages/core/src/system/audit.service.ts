import type { AuditLogItem, AuditLogListQuery } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import * as repo from './system.repo';

/**
 * The operation log viewer.
 *
 * Read-only, and there is no route that writes one: `handle()` writes a row for
 * every successful mutating admin request (rows from before the cutover may
 * also be `actorKind: 'staff'`, the deleted mobile staff console's writes), the
 * admin sign-in writes one per outcome, with
 * the body already redacted by `redactPayload`. A service that wants to name
 * what it touched calls `ctx.audit('coupon:42')` and the same writer picks it
 * up; on a read (an export) that call is what asks for a row at all.
 *
 * There is also no delete route. An operation log an operator can edit is not
 * an operation log; old rows leave through the retention job instead.
 */
export async function auditLogList(
  ctx: Ctx,
  query: AuditLogListQuery,
): Promise<{ items: AuditLogItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listAuditLogs(ctx.db, {
    actorKind: query.actorKind,
    adminId: query.adminId === undefined ? undefined : fromId(query.adminId),
    userId: query.userId === undefined ? undefined : fromId(query.userId),
    keyword: query.keyword,
    routeId: query.routeId,
    method: query.method,
    from: query.createdFrom ? new Date(query.createdFrom) : undefined,
    to: query.createdTo ? new Date(query.createdTo) : undefined,
    sortOrder: query.sortOrder,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  return {
    items: rows.map((row) => ({
      id: toId(row.id),
      actorKind: row.actorKind === 'staff' ? 'staff' : 'admin',
      adminId: toIdOrNull(row.adminId),
      userId: toIdOrNull(row.userId),
      adminAccount: row.adminAccount,
      routeId: row.routeId,
      method: row.method,
      path: row.path,
      target: row.target,
      status: row.status,
      payload: row.payload,
      requestId: row.requestId,
      ip: row.ip,
      apiTokenId: toIdOrNull(row.apiTokenId),
      apiTokenName: row.apiTokenName,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Retention sweep, called by `system.pruneAuditLogs`.
 *
 * Bounded: one call deletes at most `limit` rows, and the job runs it until it
 * returns less than a full batch. A single unbounded DELETE over a year of logs
 * is how a maintenance job takes the shop down at 3am.
 *
 * Nothing depends on this for correctness — the viewer filters by date anyway,
 * so a missed sweep only means the table is bigger than intended.
 */
export async function pruneAuditLogs(
  ctx: Ctx,
  input: { retentionDays: number; limit: number },
): Promise<number> {
  const before = new Date(ctx.clock.nowMs() - input.retentionDays * 24 * 60 * 60 * 1000);
  return repo.pruneAuditLogs(ctx.db, before, input.limit);
}
