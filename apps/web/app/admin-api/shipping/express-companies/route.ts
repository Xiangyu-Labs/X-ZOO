import {
  expressCompanyAdminList,
  expressCompanyCreate,
} from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanies } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/** `/admin-api/shipping/express-companies` — the 快递公司 management list and create form. */
export const GET = handle(expressCompanyAdminList, (ctx, { query }) =>
  expressCompanies.adminList(ctx, query),
);

export const POST = handle(expressCompanyCreate, async (ctx, { body }) => {
  const created = await expressCompanies.adminCreate(ctx, body);
  ctx.audit(`express-company:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
