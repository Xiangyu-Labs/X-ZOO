import { describe, expect, it } from 'vitest';
import { readWebhookBody } from './webhook-body';

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('https://shop.test/api/v1/webhooks/wechat-oa', {
    method: 'POST',
    body,
    headers,
    // Node's Request wants this for a stream body.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

describe('readWebhookBody', () => {
  it('reads a callback-sized body as text, 中文 included', async () => {
    expect(await readWebhookBody(post('<xml>关注</xml>'))).toBe('<xml>关注</xml>');
  });

  it('refuses on a declared length past the ceiling without reading', async () => {
    expect(await readWebhookBody(post('x', { 'content-length': '70000' }), 64)).toBeNull();
  });

  it('stops reading a body with no declared length once it passes the ceiling', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(40));
        if (pulled > 100) controller.close();
      },
    });
    expect(await readWebhookBody(post(stream), 64)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });
});
