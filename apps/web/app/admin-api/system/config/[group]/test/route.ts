import { systemConfigTest } from '@shop/contracts/system/system.settings.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../../src/server';

/**
 * `POST /admin-api/system/config/:group/test` — 「测试」 on a settings screen.
 *
 * Runs the group's test hook against the form as it stands and saves nothing.
 * Audited, because a test can send a billed SMS to a phone the operator typed.
 */
export const POST = handle(systemConfigTest, async (ctx, { params, body }) => {
  const result = await system.configTest(ctx, params, body);
  ctx.audit(`config-test:${params.group}`);
  return result;
});

export const dynamic = 'force-dynamic';
