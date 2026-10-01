import { systemAuditLogList } from '@shop/contracts/system/system.settings.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../src/server';

/** `/admin-api/audit-logs` — who did what, read-only for everybody. */
export const GET = handle(systemAuditLogList, (ctx, { query }) => system.auditLogList(ctx, query));

export const dynamic = 'force-dynamic';
