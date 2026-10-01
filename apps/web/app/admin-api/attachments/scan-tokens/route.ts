import { storageScanTokenCreate } from '@shop/contracts/storage/storage.admin.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/attachments/scan-tokens` — mint a QR code for 扫码上传.
 *
 * Per admin, single-use, ten minutes. **One** token under a fixed cache key
 * would let a phone scanning an older code upload into whichever admin had
 * opened the dialog most recently.
 */
export const POST = handle(storageScanTokenCreate, async (ctx, { query }) => {
  const minted = await storage.scanTokenCreate(ctx, query);
  // Not the token: an audit row is read by more people than hold the
  // credential. The prefix is enough to join an upload to its mint.
  ctx.audit(`scan-token:${minted.token.slice(0, 8)}`);
  return minted;
});

export const dynamic = 'force-dynamic';
