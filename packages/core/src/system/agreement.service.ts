import type { Agreement, AgreementKey } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { AGREEMENT_FIELDS, agreementConfig } from './agreement.config';
import * as repo from './system.repo';

/**
 * The public agreement read.
 *
 * Public on purpose: a shopper has to be able to read the terms *before*
 * registering, which is precisely when they have no session. Nothing here is
 * secret and nothing here is per-user.
 */
export async function agreementGet(ctx: Ctx, params: { key: AgreementKey }): Promise<Agreement> {
  const values = await ctx.config.get(agreementConfig);
  const field = AGREEMENT_FIELDS[params.key];
  const updatedAt = await repo.configGroupUpdatedAt(ctx.db, agreementConfig.group);
  return {
    key: params.key,
    title: values[field.title],
    content: values[field.content],
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}
