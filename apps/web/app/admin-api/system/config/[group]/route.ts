import { systemConfigGet, systemConfigSave } from '@shop/contracts/system/system.settings.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/system/config/:group` — every settings screen there will ever be.
 *
 * One pair of handlers, not fifty hand-written pages. A secret field is
 * write-only: the read returns a boolean "is set" flag in place of the value,
 * and saving the form without retyping leaves the stored credential alone.
 */
export const GET = handle(systemConfigGet, (ctx, { params }) => system.configGet(ctx, params));

export const PUT = handle(systemConfigSave, async (ctx, { params, body }) => {
  const saved = await system.configSave(ctx, params, body);
  ctx.audit(`config:${params.group}`);
  return saved;
});

export const dynamic = 'force-dynamic';
