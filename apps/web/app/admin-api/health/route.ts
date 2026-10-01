import { adminHealth } from '@shop/contracts/health/health.contract';
import { handle } from '../../../src/server';
import { healthPayload } from '../../../src/server/health';

/** Same check on the admin surface, so the edge can probe both prefixes. */
export const GET = handle(adminHealth, (ctx) => healthPayload(ctx));

export const dynamic = 'force-dynamic';
