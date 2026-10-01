import { expressCompanyOptions } from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanies } from '@shop/core/shipping';
import { handle } from '../../../../src/server';

/** `/api/v1/express-companies` — the enabled carriers, searched and capped, for 退货物流. */
export const GET = handle(expressCompanyOptions, (ctx, { query }) =>
  expressCompanies.shopperOptions(ctx, query),
);

export const dynamic = 'force-dynamic';
