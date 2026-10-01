import { storefrontReadiness } from '@shop/contracts/health/health.contract';
import { handle } from '../../../../src/server';
import { readinessPayload } from '../../../../src/server/health';

/**
 * Deep readiness. Public by contract; see `src/server/health.ts` for why this
 * one may touch the database while `/api/v1/health` may not.
 *
 * The edge maps the ops-conventional `/readyz` onto it
 * (`docker/edge/nginx.conf`).
 */
export const GET = handle(storefrontReadiness, (ctx) => readinessPayload(ctx));

export const dynamic = 'force-dynamic';
