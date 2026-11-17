/**
 * WeChat's callbacks (支付、退款、公众号、小程序消息推送) are a few KB. The edge lets 100 MB through
 * for uploads, so without a ceiling of its own a webhook would read whatever it is sent into
 * memory before the signature is even looked at.
 */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** The raw body as text, or `null` when it is larger than `limit` (read no further than that). */
export async function readWebhookBody(
  request: Request,
  limit = WEBHOOK_MAX_BODY_BYTES,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
