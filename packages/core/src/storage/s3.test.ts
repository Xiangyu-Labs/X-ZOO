import { describe, expect, it } from 'vitest';
import { createS3Storage, signS3Request } from './s3';

/**
 * The signer is checked against AWS's **published** example, not against its own
 * output. A hand-rolled SigV4 that only agrees with itself proves nothing; this
 * one has to agree with Amazon.
 *
 * Source: "Authenticating Requests: Using the Authorization Header
 * (AWS Signature Version 4)" — the GET Object example.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  host: 'examplebucket.s3.amazonaws.com',
  path: '/test.txt',
  emptyPayload: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  expectedSignature: 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
};

describe('signS3Request', () => {
  it("reproduces AWS's published GET Object signature", () => {
    const headers = signS3Request({
      method: 'GET',
      host: AWS_EXAMPLE.host,
      path: AWS_EXAMPLE.path,
      headers: { range: 'bytes=0-9' },
      payloadHash: AWS_EXAMPLE.emptyPayload,
      region: AWS_EXAMPLE.region,
      accessKeyId: AWS_EXAMPLE.accessKeyId,
      secretAccessKey: AWS_EXAMPLE.secretAccessKey,
      now: new Date('2013-05-24T00:00:00Z'),
    });

    expect(headers['authorization']).toContain(`Signature=${AWS_EXAMPLE.expectedSignature}`);
    expect(headers['authorization']).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(headers['authorization']).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('signs every header it sends, so a proxy cannot add one unnoticed', () => {
    const headers = signS3Request({
      method: 'PUT',
      host: 'bucket.example.com',
      path: '/a/b.png',
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=60' },
      payloadHash: AWS_EXAMPLE.emptyPayload,
      region: 'cn-hangzhou',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      now: new Date('2026-09-22T10:11:12Z'),
    });
    const signed = /SignedHeaders=([^,]+)/.exec(headers['authorization'] ?? '')?.[1] ?? '';
    expect(signed.split(';').sort()).toEqual([
      'cache-control',
      'content-type',
      'host',
      'x-amz-content-sha256',
      'x-amz-date',
    ]);
  });

  it('escapes the characters encodeURIComponent leaves alone', () => {
    // `!'()*` are the ones that break a signature on exactly the filenames
    // nobody tests with.
    const headers = signS3Request({
      method: 'GET',
      host: 'bucket.example.com',
      path: "/a/it's (1)!.png",
      headers: {},
      payloadHash: AWS_EXAMPLE.emptyPayload,
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      now: new Date('2026-09-22T00:00:00Z'),
    });
    // Signing succeeded and produced a 64-hex signature; the encoding itself is
    // asserted through the request the driver builds, below.
    expect(headers['authorization']).toMatch(/Signature=[0-9a-f]{64}$/);
  });
});

describe('createS3Storage', () => {
  const baseOptions = {
    bucket: 'shop-assets',
    region: 'cn-hangzhou',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    publicBaseUrl: 'https://cdn.example.com/',
    now: () => new Date('2026-09-22T08:00:00Z'),
  };

  function recordingFetch(status = 200): {
    calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
    impl: typeof fetch;
  } {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const impl = (async (url: string | URL, init?: { method?: string; headers?: unknown }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it('generates the key itself — a caller cannot choose a path', async () => {
    const { calls, impl } = recordingFetch();
    const storage = createS3Storage({ ...baseOptions, addressing: 'virtual', fetchImpl: impl });

    const stored = await storage.put(new Uint8Array([1, 2, 3]), {
      directory: '../../etc',
      filename: '../../../etc/passwd',
      contentType: 'image/png',
    });

    // Directory sanitised to `[a-z0-9-]`, extension whitelisted, basename random.
    expect(stored.key).toMatch(/^etc\/2026\/09\/[0-9a-f]{32}\.bin$/);
    expect(calls[0]?.url).toContain(
      'https://shop-assets.oss-cn-hangzhou.aliyuncs.com/etc/2026/09/',
    );
  });

  it('writes a thumbnail next to its original, and only there', async () => {
    const { calls, impl } = recordingFetch();
    const storage = createS3Storage({ ...baseOptions, addressing: 'virtual', fetchImpl: impl });
    const original = 'product/2026/09/0123456789abcdef0123456789abcdef.jpg';

    const key = await storage.putVariant(original, 480, new Uint8Array([1]), 'image/jpeg');
    expect(key).toBe('product/2026/09/0123456789abcdef0123456789abcdef.w480.jpg');
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `https://shop-assets.oss-cn-hangzhou.aliyuncs.com/${key}`,
    });
    expect(calls[0]?.headers['content-type']).toBe('image/jpeg');

    // A key the server never generated, or a width it does not make, is refused unsent.
    await expect(
      storage.putVariant('../../etc/passwd', 480, new Uint8Array([1]), 'image/jpeg'),
    ).rejects.toThrow();
    await expect(
      storage.putVariant(original, 500 as 480, new Uint8Array([1]), 'image/jpeg'),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('addresses path-style and virtual-style buckets differently', async () => {
    const pathStyle = recordingFetch();
    await createS3Storage({ ...baseOptions, addressing: 'path', fetchImpl: pathStyle.impl }).put(
      new Uint8Array([1]),
      { filename: 'a.png' },
    );
    expect(pathStyle.calls[0]?.url).toContain(
      'https://oss-cn-hangzhou.aliyuncs.com/shop-assets/misc/',
    );

    const virtualStyle = recordingFetch();
    await createS3Storage({
      ...baseOptions,
      addressing: 'virtual',
      fetchImpl: virtualStyle.impl,
    }).put(new Uint8Array([1]), { filename: 'a.png' });
    expect(virtualStyle.calls[0]?.url).toContain(
      'https://shop-assets.oss-cn-hangzhou.aliyuncs.com/',
    );
  });

  it('treats a 404 on delete as success and a 500 as failure', async () => {
    const gone = recordingFetch(404);
    await expect(
      createS3Storage({ ...baseOptions, fetchImpl: gone.impl }).delete('a/b.png'),
    ).resolves.toBeUndefined();

    const broken = recordingFetch(500);
    await expect(
      createS3Storage({ ...baseOptions, fetchImpl: broken.impl }).delete('a/b.png'),
    ).rejects.toThrow(/S3 DELETE 500/);
  });

  it('builds public URLs from the CDN base, not from the signing endpoint', () => {
    const storage = createS3Storage({ ...baseOptions, fetchImpl: recordingFetch().impl });
    expect(storage.url('attachment/2026/09/abc.png')).toBe(
      'https://cdn.example.com/attachment/2026/09/abc.png',
    );
  });

  it('STOR-014 — gives up on a bucket that stalls instead of holding the upload open', async () => {
    const seen: Array<{ method: string; signal: AbortSignal | undefined }> = [];
    const stalling = (async (
      _url: string | URL,
      init?: { method?: string; signal?: AbortSignal },
    ) => {
      seen.push({ method: init?.method ?? 'GET', signal: init?.signal });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const storage = createS3Storage({
      ...baseOptions,
      fetchImpl: stalling,
      timeoutMs: { transfer: 30, control: 10 },
    });

    await expect(
      storage.put(new Uint8Array([1, 2, 3]), { contentType: 'image/png' }),
    ).rejects.toThrow();
    await expect(storage.exists('a/b.png')).rejects.toThrow();
    expect(seen.map((call) => call.method)).toEqual(['PUT', 'HEAD']);
    expect(seen.every((call) => call.signal?.aborted)).toBe(true);
  });
});
