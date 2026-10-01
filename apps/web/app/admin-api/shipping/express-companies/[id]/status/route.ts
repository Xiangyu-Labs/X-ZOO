import { expressCompanySetStatus } from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanies } from '@shop/core/shipping';
import { handle } from '../../../../../../src/server';

export const POST = handle(expressCompanySetStatus, async (ctx, { params, body }) => {
  const updated = await expressCompanies.adminSetStatus(ctx, params, body);
  ctx.audit(`express-company:${updated.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
