import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// A test-only fixture shared by the TLS-001 tests of `wechat` and `storage`;
// its natural home is `@shop/testing`.
// eslint-disable-next-line boundaries/core-cross-domain
import { startHttpsServer, type NamedHttpsServer } from '../wechat/__fixtures__/untrusted-https';
import {
  classifyAddress,
  pinnedTransport,
  safeFetch,
  SafeFetchError,
  type AddressVerdict,
  type SafeFetchOptions,
} from './safe-fetch';

/**
 * `safeFetch` over a real socket and a real TLS handshake.
 *
 * Every other `safeFetch` test injects its transport, so none of them ever
 * opens a connection — and so none of them would notice "every https import
 * fails certificate validation": dialling `https://93.184.216.34/…` fails,
 * because a certificate names hosts, not addresses.
 *
 * Here the servers present certificates that name **DNS names only** (no IP
 * SAN, like a real CDN's), for names that do not exist in any DNS
 * (`*.shop.test`). The resolver seam answers them with a loopback address and
 * the address rules are relaxed for loopback, the one thing a real-socket test
 * can reach. So a success proves all of it at once:
 *
 * - the socket went to the judged address (the name has no DNS answer to go
 *   anywhere else — no second lookup happened);
 * - SNI carried the name (the server records it);
 * - the certificate was validated against the name, with verification on.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let cdn: NamedHttpsServer;
let hop: NamedHttpsServer;
let other: NamedHttpsServer;

beforeAll(async () => {
  const now = new Date();
  cdn = await startHttpsServer({
    now,
    hosts: ['cdn.shop.test'],
    ipSan: false,
    handler: (req, res) => {
      if (req.url === '/moved.png') {
        res.writeHead(302, { location: `https://img.shop.test:${hop.port}/banner.png` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    },
  });
  // A second host on a second loopback address: a redirect must be dialled at
  // *its* judged address, not the first hop's.
  hop = await startHttpsServer({
    now,
    hosts: ['img.shop.test'],
    ipSan: false,
    bind: '127.0.0.2',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    },
  });
  other = await startHttpsServer({
    now,
    hosts: ['somebody-else.test'],
    ipSan: false,
    handler: (_req, res) => {
      res.writeHead(200);
      res.end(PNG);
    },
  });
}, 30_000);

afterAll(async () => {
  await Promise.all([cdn?.close(), hop?.close(), other?.close()]);
});

const DNS: Record<string, string> = {
  'cdn.shop.test': '127.0.0.1',
  'img.shop.test': '127.0.0.2',
  'wrong.shop.test': '127.0.0.1',
};

/** Loopback is the only thing a real-socket test can reach; nothing else is relaxed. */
const loopbackAllowed = (address: string): AddressVerdict =>
  address.startsWith('127.') ? { blocked: false } : classifyAddress(address);

function options(extra: SafeFetchOptions = {}): SafeFetchOptions {
  return {
    resolve: async (host) => {
      const address = DNS[host];
      if (!address) throw new Error(`no such host ${host}`);
      return [address];
    },
    judgeAddress: loopbackAllowed,
    allowedPorts: [cdn.port, hop.port, other.port],
    transport: pinnedTransport({ ca: [cdn.certificate, hop.certificate, other.certificate] }),
    timeoutMs: 5000,
    ...extra,
  };
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

describe('safeFetch over real TLS', () => {
  it('imports an https source: judged address, real name for SNI and the certificate', async () => {
    const before = cdn.servernames.length;
    const result = await safeFetch(`https://cdn.shop.test:${cdn.port}/banner.png`, options());

    expect(Buffer.from(result.bytes)).toEqual(PNG);
    expect(result.contentType).toBe('image/png');
    expect(result.url).toBe(`https://cdn.shop.test:${cdn.port}/banner.png`);
    expect(cdn.servernames.slice(before)).toEqual(['cdn.shop.test']);
  });

  it('dials each redirect hop at that hop’s own judged address', async () => {
    const before = hop.servernames.length;
    const result = await safeFetch(`https://cdn.shop.test:${cdn.port}/moved.png`, options());

    expect(result.url).toBe(`https://img.shop.test:${hop.port}/banner.png`);
    expect(Buffer.from(result.bytes)).toEqual(PNG);
    // Only 127.0.0.2 listens on this port, so arriving there is the proof.
    expect(hop.servernames.slice(before)).toEqual(['img.shop.test']);
  });

  it('refuses a certificate that does not name the host, trusted CA or not', async () => {
    // `wrong.shop.test` is pinned at the server whose certificate says
    // `cdn.shop.test`: the identity check is against the URL's name.
    const error = await refusal(
      safeFetch(`https://wrong.shop.test:${cdn.port}/banner.png`, options()),
    );
    expect(error.kind).toBe('failed');
  });

  it('keeps certificate verification on in the production transport (TLS-001)', async () => {
    // No `ca`: the self-signed certificate is not trusted, and the fetch
    // fails at the handshake — there is no switch that turns this off.
    const before = cdn.servernames.length;
    const error = await refusal(
      safeFetch(
        `https://cdn.shop.test:${cdn.port}/banner.png`,
        options({ transport: pinnedTransport() }),
      ),
    );
    expect(error.kind).toBe('failed');
    expect(cdn.servernames.length).toBe(before);
  });

  it('uses the production transport when none is injected', async () => {
    const { transport: _ignored, ...withoutTransport } = options();
    const before = cdn.servernames.length;
    const error = await refusal(
      safeFetch(`https://cdn.shop.test:${cdn.port}/banner.png`, withoutTransport),
    );
    // The default is the verifying transport: same refusal, nothing served.
    expect(error.kind).toBe('failed');
    expect(cdn.servernames.length).toBe(before);
  });

  it('still refuses loopback for a caller that did not relax it', async () => {
    const { judgeAddress: _ignored, ...strict } = options();
    const error = await refusal(safeFetch(`https://cdn.shop.test:${cdn.port}/banner.png`, strict));
    expect(error).toMatchObject({ kind: 'refused', message: 'loopback' });
  });
});
