import {
  expressCompanyDelete,
  expressCompanyUpdate,
} from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanies } from '@shop/core/shipping';
import { handle } from '../../../../../src/server';

export const PUT = handle(expressCompanyUpdate, async (ctx, { params, body }) => {
  const updated = await expressCompanies.adminUpdate(ctx, params, body);
  ctx.audit(`express-company:${updated.id}`);
  return updated;
});

export const DELETE = handle(expressCompanyDelete, async (ctx, { params }) => {
  const result = await expressCompanies.adminDelete(ctx, params);
  ctx.audit(`express-company:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
