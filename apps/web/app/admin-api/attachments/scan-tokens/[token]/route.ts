import { storageScanTokenStatus } from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/attachments/scan-tokens/:token` — has the phone uploaded yet?
 *
 * A token minted by another admin reads as `expired`: there is no reason for
 * one operator to learn that another's QR code exists.
 */
export const GET = handle(storageScanTokenStatus, (ctx, { params }) =>
  storage.scanTokenStatusGet(ctx, params),
);

export const dynamic = 'force-dynamic';
