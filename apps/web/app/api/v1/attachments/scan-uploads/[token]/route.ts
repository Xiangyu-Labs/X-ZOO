import { storageScanUpload } from '@shop/contracts/storage/storage.storefront.contract';
import * as storage from '@shop/core/storage';
import { handle } from '../../../../../../src/server';
import { clientIp } from '../../../../../../src/server/request-meta';

/**
 * `/api/v1/attachments/scan-uploads/:token` — the phone's half of 扫码上传.
 *
 * Public by contract, because the phone that scanned the code has no session:
 * the token *is* the authorisation. So it is claimed by an atomic Redis script
 * before anything is stored, exactly once, and the attachment is attributed to
 * the admin who minted it rather than to nobody.
 *
 * The body is handed over as a reader, not read here: `scanUpload` spends the
 * per-address and per-code budgets and checks the code first, so a stranger
 * cannot make the server parse multipart bodies as fast as it can send them.
 */
export const POST = handle(storageScanUpload, async (ctx, { params }) =>
  storage.scanUpload(ctx, params, (maxBytes) => storage.readFilePart(ctx.request, { maxBytes }), {
    ip: clientIp(ctx.request),
  }),
);

export const dynamic = 'force-dynamic';
