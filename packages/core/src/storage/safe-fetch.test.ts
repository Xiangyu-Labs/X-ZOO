import { describe, expect, it, vi } from 'vitest';
import {
  classifyAddress,
  safeFetch,
  SafeFetchError,
  type PinnedRequest,
  type Transport,
} from './safe-fetch';

/**
 * The SSRF guard.
 *
 * The old `onlineUpload` called `file_get_contents($url)`. Everything below is
 * a request that would have succeeded there and must fail here — including the
 * two that a hostname blocklist does not stop: a public name that *resolves* to
 * a private address, and a public URL that *redirects* to one.
 */

const PUBLIC_IP = '93.184.216.34';

function fetchReturning(
  body: Uint8Array | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): { impl: Transport; calls: string[] } {
  const calls: string[] = [];
  const impl: Transport = async ({ url }) => {
    calls.push(String(url));
    return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
  };
  return { impl, calls };
}

async function refusal(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error;
    throw error;
  }
  throw new Error('expected a SafeFetchError');
}

describe('classifyAddress', () => {
  it('blocks every address family a fetch must never reach', () => {
    const blocked = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // AWS/Aliyun instance metadata
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '::ffff:169.254.169.254', // the IPv4-mapped bypass
      '::ffff:127.0.0.1',
      '64:ff9b::1', // NAT64
      '2002:7f00:1::', // 6to4
    ];
    for (const address of blocked) {
      expect(classifyAddress(address), address).toMatchObject({ blocked: true });
    }
  });

  it('STOR-004 — judges the IPv4 inside an IPv6 spelling, however it is written', () => {
    const blocked = [
      '::ffff:7f00:1', // what `new URL` makes of [::ffff:127.0.0.1]
      '::ffff:a9fe:a9fe', // 169.254.169.254, hex
      '::ffff:ac11:1', // 172.17.0.1, the docker gateway
      '0:0:0:0:0:ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::7f00:1', // IPv4-compatible (::/96)
      '::127.0.0.1',
      '::a9fe:a9fe',
      'fe90::1', // link-local is fe80::/10, not just fe80:
      'febf::1',
      'fec0::1', // site-local
    ];
    for (const address of blocked) {
      expect(classifyAddress(address), address).toMatchObject({ blocked: true });
    }
    // A public address stays public in either spelling.
    expect(classifyAddress('::ffff:808:808')).toEqual({ blocked: false });
    expect(classifyAddress('::ffff:8.8.8.8')).toEqual({ blocked: false });
  });

  it('allows ordinary public addresses', () => {
    for (const address of [PUBLIC_IP, '8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(classifyAddress(address), address).toEqual({ blocked: false });
    }
  });

  it('blocks anything that is not an IP address at all', () => {
    expect(classifyAddress('localhost')).toMatchObject({ blocked: true });
    expect(classifyAddress('')).toMatchObject({ blocked: true });
  });
});

describe('safeFetch — refusals', () => {
  const resolve = async (): Promise<string[]> => [PUBLIC_IP];

  it('refuses non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com']) {
      expect((await refusal(safeFetch(url, { resolve }))).kind).toBe('refused');
    }
  });

  // A plaintext import is a man-in-the-middle's choice of file.
  it('refuses plain http unless the caller allows it', async () => {
    const { impl, calls } = fetchReturning(new Uint8Array([1]));
    const error = await refusal(
      safeFetch('http://example.com/a.png', { resolve, transport: impl }),
    );
    expect(error).toMatchObject({ kind: 'refused', message: 'scheme http:' });
    expect(calls).toEqual([]);

    await expect(
      safeFetch('http://example.com/a.png', { resolve, transport: impl, allowHttp: true }),
    ).resolves.toMatchObject({ url: 'http://example.com/a.png' });
  });

  it('refuses an https source that redirects to plain http', async () => {
    const impl: Transport = async ({ url }) =>
      url.protocol === 'https:'
        ? new Response(null, { status: 302, headers: { location: 'http://example.com/b.png' } })
        : new Response(new Uint8Array([1]));
    const error = await refusal(
      safeFetch('https://example.com/a.png', { resolve, transport: impl }),
    );
    expect(error).toMatchObject({ kind: 'refused', message: 'scheme http:' });
  });

  it('refuses credentials in the URL', async () => {
    const error = await refusal(safeFetch('https://user:pass@example.com/a.png', { resolve }));
    expect(error.message).toBe('credentials in URL');
  });

  it('refuses a non-standard port, so this is not a port scanner', async () => {
    expect((await refusal(safeFetch('https://example.com:6379/', { resolve }))).message).toBe(
      'port 6379',
    );
    // Unless the operator allowed it explicitly.
    const { impl } = fetchReturning(new Uint8Array([1]));
    await expect(
      safeFetch('https://example.com:8080/a.png', {
        resolve,
        transport: impl,
        allowedPorts: [8080],
      }),
    ).resolves.toMatchObject({ url: 'https://example.com:8080/a.png' });
  });

  it('refuses a literal private address', async () => {
    expect((await refusal(safeFetch('https://169.254.169.254/latest/meta-data/'))).kind).toBe(
      'refused',
    );
    expect((await refusal(safeFetch('https://127.0.0.1:80/'))).kind).toBe('refused');
    expect((await refusal(safeFetch('https://[::1]/'))).kind).toBe('refused');
    // `new URL` hands these over as `::ffff:7f00:1` and `::ffff:ac11:1`.
    expect((await refusal(safeFetch('https://[::ffff:127.0.0.1]/'))).kind).toBe('refused');
    expect((await refusal(safeFetch('https://[::ffff:172.17.0.1]/'))).kind).toBe('refused');
  });

  it('refuses hostnames that exist to be loopback', async () => {
    for (const url of ['https://localhost/a', 'https://foo.localhost/a', 'https://db.internal/a']) {
      expect((await refusal(safeFetch(url))).message).toBe('loopback hostname');
    }
  });

  // The two that a blocklist does not catch.

  it('refuses a public name that RESOLVES to a private address', async () => {
    // `localtest.me` and friends are public names with an A record of 127.0.0.1.
    const error = await refusal(
      safeFetch('https://totally-normal.example.com/a.png', {
        resolve: async () => ['127.0.0.1'],
      }),
    );
    expect(error.kind).toBe('refused');
    expect(error.message).toBe('loopback');
  });

  it('refuses a name that resolves to one public AND one private address', async () => {
    // A multi-homed CDN does not answer with 10.0.0.5. A rebinding attempt does.
    const error = await refusal(
      safeFetch('https://example.com/a.png', { resolve: async () => [PUBLIC_IP, '10.0.0.5'] }),
    );
    expect(error.kind).toBe('refused');
  });

  it('refuses a redirect into the private network', async () => {
    const impl: Transport = async ({ url }) => {
      if (String(url).includes('/start')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data/' },
        });
      }
      return new Response(new Uint8Array([1]));
    };

    const error = await refusal(
      safeFetch('https://example.com/start', { resolve, transport: impl }),
    );
    expect(error.kind).toBe('refused');
  });

  it('stops after too many redirects', async () => {
    const impl: Transport = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/next' },
      });
    const error = await refusal(
      safeFetch('https://example.com/a', { resolve, transport: impl, maxRedirects: 2 }),
    );
    expect(error.message).toBe('too many redirects');
  });

  it('stops reading at maxBytes even when Content-Length lied', async () => {
    const impl: Transport = async () =>
      new Response(new Uint8Array(4096), {
        headers: { 'content-length': '10' },
      });
    const error = await refusal(
      safeFetch('https://example.com/big', { resolve, transport: impl, maxBytes: 1024 }),
    );
    expect(error.kind).toBe('failed');
    expect(error.message).toBe('too large');
  });

  it('refuses a declared Content-Length over the ceiling before reading', async () => {
    const { impl } = fetchReturning(new Uint8Array([1]), {
      headers: { 'content-length': String(50 * 1024 * 1024) },
    });
    expect(
      (await refusal(safeFetch('https://example.com/big', { resolve, transport: impl }))).message,
    ).toBe('too large');
  });

  it('reports an upstream error as a failure, not a refusal', async () => {
    const { impl } = fetchReturning(null, { status: 503 });
    expect(
      (await refusal(safeFetch('https://example.com/a', { resolve, transport: impl }))).kind,
    ).toBe('failed');
  });
});

describe('safeFetch — the happy path', () => {
  it('connects to the address it judged, presenting the original Host', async () => {
    // This is what closes the DNS-rebinding window: there is no second lookup
    // between the check and the connection for anybody to win. And the URL
    // keeps the name, so SNI and the certificate check see the name too (an
    // IP-literal URL would fail every https certificate).
    const seen: PinnedRequest[] = [];
    const impl: Transport = async (request) => {
      seen.push(request);
      return new Response(new Uint8Array([0x89, 0x50]), {
        headers: { 'content-type': 'image/png' },
      });
    };

    const result = await safeFetch('https://cdn.example.com/banner.png', {
      resolve: async () => [PUBLIC_IP],
      transport: impl,
    });

    expect(seen[0]?.url.toString()).toBe('https://cdn.example.com/banner.png');
    expect(seen[0]?.address).toBe(PUBLIC_IP);
    expect(seen[0]?.headers['host']).toBeUndefined();
    expect(result.contentType).toBe('image/png');
    expect(result.bytes).toEqual(new Uint8Array([0x89, 0x50]));
    expect(result.url).toBe('https://cdn.example.com/banner.png');
  });

  it('re-judges the hostname of a relative redirect against the real host', async () => {
    const resolve = vi.fn(async () => [PUBLIC_IP]);
    const impl: Transport = async ({ url }) => {
      if (String(url).endsWith('/a')) {
        return new Response(null, { status: 301, headers: { location: '/b.png' } });
      }
      return new Response(new Uint8Array([1]));
    };

    const result = await safeFetch('https://cdn.example.com/a', { resolve, transport: impl });
    expect(result.url).toBe('https://cdn.example.com/b.png');
    // Resolved again for the second hop rather than reusing the first verdict.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('pins each redirect hop to that hop’s own judged address', async () => {
    const addresses: Record<string, string> = {
      'cdn.example.com': PUBLIC_IP,
      'img.example.net': '8.8.4.4',
    };
    const seen: Array<[string, string]> = [];
    const impl: Transport = async ({ url, address }) => {
      seen.push([url.hostname, address]);
      return url.hostname === 'cdn.example.com'
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://img.example.net/b.png' },
          })
        : new Response(new Uint8Array([1]));
    };
    await safeFetch('https://cdn.example.com/a', {
      resolve: async (host) => [addresses[host]!],
      transport: impl,
    });
    expect(seen).toEqual([
      ['cdn.example.com', PUBLIC_IP],
      ['img.example.net', '8.8.4.4'],
    ]);
  });
});
