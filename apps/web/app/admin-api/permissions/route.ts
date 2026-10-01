import { systemPermissionTree } from '@shop/contracts/system/system.role.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../src/server';

/**
 * `/admin-api/permissions` — every atom the running build declares.
 *
 * The set of atoms is compiled in, not stored: adding one is a code change, so
 * this endpoint is the single source the role editor renders from and cannot
 * drift from what `handle()` actually enforces.
 */
export const GET = handle(systemPermissionTree, (ctx) => system.permissionTreeRoute(ctx));

export const dynamic = 'force-dynamic';
