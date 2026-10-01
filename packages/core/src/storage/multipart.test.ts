import { describe, expect, it } from 'vitest';
import { DomainError } from '../kernel/errors';
import { MULTIPART_OVERHEAD_BYTES, readFilePart } from './multipart';

/**
 * The multipart field name is part of the contract.
 *
 * Accepting three names — `file`, `multipart`, `image` — would mean the
 * contract could not state one, `openapi.json` could not describe the request,
 * and a client sending a fourth would fail with "请选择要上传的文件" no matter
 * how many times the shopper picked the photo. One name, and a distinct error
 * for the client that used another.
 */

const asRequest = (form: FormData) => ({ formData: async () => form });

const blob = (content = 'png-bytes', name = 'photo.png', type = 'image/png') =>
  new File([content], name, { type });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
}

describe('readFilePart', () => {
  it('reads the part named file', async () => {
    const form = new FormData();
    form.set('file', blob());

    const part = await readFilePart(asRequest(form));
    expect(part.filename).toBe('photo.png');
    expect(part.declaredMime).toBe('image/png');
    expect(new TextDecoder().decode(part.bytes)).toBe('png-bytes');
  });

  it('names the fix when the file arrived under another field', async () => {
    for (const wrong of ['image', 'multipart', 'avatar']) {
      const form = new FormData();
      form.set(wrong, blob());

      const error = await readFilePart(asRequest(form)).then(
        () => null,
        (caught: unknown) => caught as DomainError,
      );
      expect(error?.code).toBe('STORAGE_UPLOAD_FIELD_MISSING');
      expect(error?.details).toEqual({ expected: 'file', received: [wrong] });
    }
  });

  it('ignores extra file parts, because `file` is the upload', async () => {
    const form = new FormData();
    form.set('file', blob('the-one', 'wanted.png'));
    form.set('thumbnail', blob('ignored', 'other.png'));

    const part = await readFilePart(asRequest(form));
    expect(part.filename).toBe('wanted.png');
  });

  it('is STORAGE_NO_FILE when there is no file at all, only text fields', async () => {
    const form = new FormData();
    form.set('purpose', 'review');
    expect(await codeOf(readFilePart(asRequest(form)))).toBe('STORAGE_NO_FILE');
  });

  it('is STORAGE_NO_FILE for an empty part, not a field-name complaint', async () => {
    const form = new FormData();
    form.set('file', blob(''));
    expect(await codeOf(readFilePart(asRequest(form)))).toBe('STORAGE_NO_FILE');
  });

  it('turns a malformed body into a 4xx rather than a 500', async () => {
    const request = {
      formData: async () => {
        throw new Error('boundary not found');
      },
    };
    expect(await codeOf(readFilePart(request))).toBe('STORAGE_NO_FILE');
  });
});

describe('STOR-013 — a body over the ceiling is refused before it is buffered', () => {
  const MAX = 1024;

  /** A real multipart request, so the reader parses what a client sends. */
  function multipart(
    content: string,
    { chunked = false, length }: { chunked?: boolean; length?: string } = {},
  ) {
    const form = new FormData();
    form.set('file', blob(content));
    const encoded = new Request('http://shop.test/', { method: 'POST', body: form });
    const contentType = encoded.headers.get('content-type') ?? '';
    return encoded.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      const headers = new Headers({ 'content-type': contentType });
      if (!chunked) headers.set('content-length', length ?? String(bytes.byteLength));
      let formDataCalls = 0;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled >= bytes.byteLength) return controller.close();
            const chunk = bytes.subarray(pulled, pulled + 256);
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          },
        },
        // Pull only when read, so `pulled` counts what the reader asked for.
        { highWaterMark: 0 },
      );
      return {
        request: {
          headers,
          body,
          formData: () => {
            formDataCalls += 1;
            return new Response(bytes, { headers: { 'content-type': contentType } }).formData();
          },
        },
        formDataCalls: () => formDataCalls,
        pulled: () => pulled,
      };
    });
  }

  it('refuses a Content-Length over the ceiling without reading the body', async () => {
    const big = await multipart('x', { length: String(MAX + MULTIPART_OVERHEAD_BYTES + 1) });
    const error = await readFilePart(big.request, { maxBytes: MAX }).then(
      () => null,
      (caught: unknown) => caught as DomainError,
    );
    expect(error?.code).toBe('STORAGE_FILE_TOO_LARGE');
    expect(big.formDataCalls()).toBe(0);
    expect(big.pulled()).toBe(0);
  });

  it('stops reading a body with no length once it passes the ceiling', async () => {
    const big = await multipart('x'.repeat(MAX + MULTIPART_OVERHEAD_BYTES + 4096), {
      chunked: true,
    });
    expect(await codeOf(readFilePart(big.request, { maxBytes: MAX }))).toBe(
      'STORAGE_FILE_TOO_LARGE',
    );
    expect(big.formDataCalls()).toBe(0);
    expect(big.pulled()).toBeLessThanOrEqual(MAX + MULTIPART_OVERHEAD_BYTES + 512);
  });

  it('reads a file within the ceiling, with or without a length', async () => {
    for (const chunked of [false, true]) {
      const small = await multipart('png-bytes', { chunked });
      const part = await readFilePart(small.request, { maxBytes: MAX });
      expect(new TextDecoder().decode(part.bytes)).toBe('png-bytes');
      expect(part.filename).toBe('photo.png');
    }
  });

  it('treats a Content-Length that is not a number as a bad request', async () => {
    const odd = await multipart('png-bytes', { length: 'abc' });
    expect(await codeOf(readFilePart(odd.request, { maxBytes: MAX }))).toBe('STORAGE_NO_FILE');
  });
});
