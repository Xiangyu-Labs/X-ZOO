import { expressCompanyPicker } from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanies } from '@shop/core/shipping';
import { handle } from '../../../src/server';

/**
 * `/admin-api/express-companies` — the picker on the 发货 form.
 *
 * Served by the `shipping` domain under the `order:order:read` permission: an
 * operator trusted to dispatch goods needs no second grant to see
 * the carrier list.
 */
export const GET = handle(expressCompanyPicker, (ctx) => expressCompanies.pickerList(ctx));

export const dynamic = 'force-dynamic';
