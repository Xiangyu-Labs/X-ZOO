import { storefrontHealth } from '@shop/contracts/health/health.contract';
import { handle } from '../../../../src/server';
import { healthPayload } from '../../../../src/server/health';

/**
 * Storefront health check. Public by contract: the container healthcheck and
 * the edge both call it, and neither has a session.
 */
export const GET = handle(storefrontHealth, (ctx) => healthPayload(ctx));

export const dynamic = 'force-dynamic';
