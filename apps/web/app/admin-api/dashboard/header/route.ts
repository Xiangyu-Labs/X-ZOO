import { systemDashboardHeader } from '@shop/contracts/system/system.settings.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/dashboard/header` — the home page's tiles.
 *
 * Every domain contributes its own; a contributor that fails names itself in
 * `degraded` and the rest of the page still paints. A dashboard is the first
 * screen an operator opens during an incident, so it must not be the second
 * casualty.
 */
export const GET = handle(systemDashboardHeader, (ctx) => system.dashboardHeader(ctx));

export const dynamic = 'force-dynamic';
