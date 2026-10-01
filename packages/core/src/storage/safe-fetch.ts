import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Fetching a URL somebody typed into the admin, without handing them the
 * internal network.
 *
 * `docs/conventions.md`: "Never: … `fetch` of a user-supplied URL outside
 * `core/storage/safe-fetch.ts`". This is that file, and it is the only place in
 * the system allowed to do it.
 *
 * A plain fetch of the URL reaches `http://127.0.0.1:6379`,
 * `http://169.254.169.254/latest/meta-data/` and every service on the private
 * network, and a blocklist of hostnames does not stop any of it: `localtest.me`
 * resolves to 127.0.0.1, and a host you checked a moment ago can answer
 * differently the next time (DNS rebinding).
 *
 * So the rule here is **resolve first, judge the address, then connect to that
 * address** — and do it again for every redirect:
 *
 * 1. scheme must be `https:` (or `http:` where the caller allows it); no
 *    `file:`, `ftp:`, `gopher:`, no credentials in the URL, no non-standard
 *    port unless allowed;
 * 2. resolve the hostname ourselves, and refuse if *any* resolved address is
 *    private, loopback, link-local, unique-local, multicast, broadcast,
 *    unspecified, carrier-grade NAT, or a cloud metadata address;
 * 3. connect to the address we judged — pinned in the *connection layer*, with
 *    the URL still carrying the real name — so DNS cannot change its mind in
 *    between, and TLS still sends the name as SNI and checks the certificate
 *    against it (dialling an IP literal would break every `https://` source,
 *    because a certificate names hosts, not addresses);
 * 4. follow redirects manually, re-running all of the above on each hop;
 * 5. stop reading at `maxBytes` — a 4-byte URL must not be able to buy a 40GB
 *    download.
 */

export interface SafeFetchOptions {
  /** Hard ceiling on the response body. Reading stops here and it is refused. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Ports other than 80/443. Empty by default: port scanning is not a feature. */
  allowedPorts?: readonly number[];
  /**
   * Plain `http:` — off by default, on every hop. A plaintext fetch is a
   * man-in-the-middle's choice of file, and the failure is silent: the shop
   * just has a different image. An https URL that redirects to http is refused
   * the same way.
   */
  allowHttp?: boolean;
  /**
   * Test seam. Production resolves through the system resolver; the tests
   * substitute one so "what happens when this name resolves to 127.0.0.1" is a
   * fast, deterministic unit test rather than a network-dependent one.
   */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Test seam: the request itself. Production uses `pinnedTransport()`; a stub
   * sees the real URL and the address it must dial.
   */
  transport?: Transport;
  /**
   * Test seam, and the only way past the address rules: a real-socket test has
   * nothing but loopback to talk to. No production caller passes it.
   */
  judgeAddress?: (address: string) => AddressVerdict;
}

/** One request, already judged: where it goes, and what it is called. */
export interface PinnedRequest {
  /** The URL as written: the real hostname, for `Host`, SNI and the certificate check. */
  url: URL;
  /** The address `resolveAndJudge` approved. The socket goes here and nowhere else. */
  address: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type Transport = (request: PinnedRequest) => Promise<Response>;

export type AddressVerdict = { blocked: true; reason: string } | { blocked: false };

export interface SafeFetchResult {
  bytes: Uint8Array;
  /** The server's `Content-Type`, untrusted — the caller still sniffs the bytes. */
  contentType: string | undefined;
  /** The final URL after redirects. */
  url: string;
}

export class SafeFetchError extends Error {
  constructor(
    readonly kind: 'refused' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const DEFAULTS = {
  maxBytes: 20 * 1024 * 1024,
  timeoutMs: 8000,
  maxRedirects: 3,
} as const;

// ---------------------------------------------------------------------------
// address judgement
// ---------------------------------------------------------------------------

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/**
 * The 16 bytes of an IPv6 address, or `null`. Takes every spelling `isIP`
 * accepts — `::` compression, a dotted IPv4 tail (`::ffff:1.2.3.4`) — and
 * refuses a zone id (`fe80::1%eth0`) rather than guess what it names.
 */
function ipv6ToBytes(address: string): number[] | null {
  if (address.includes('%')) return null;
  let text = address;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const v4 = ipv4ToInt(dotted[1]);
    if (v4 === null) return null;
    tail.push(v4 >>> 24, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
    text = text.slice(0, -dotted[1].length);
    // `::1.2.3.4` leaves `::`; `::ffff:1.2.3.4` leaves `::ffff:`.
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string | undefined): number[] | null => {
    if (part === undefined || part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = parseInt(group, 16);
      out.push(value >>> 8, value & 0xff);
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const rest = groupsOf(halves[1]);
  if (head === null || rest === null) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) return known === 16 ? [...head, ...tail] : null;
  if (known > 14) return null;
  return [...head, ...new Array<number>(16 - known).fill(0), ...rest, ...tail];
}

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return { blocked: true, reason: 'unparseable address' };
    for (const [base, bits, reason] of BLOCKED_V4) {
      const baseValue = ipv4ToInt(base);
      if (baseValue === null) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((value & mask) === (baseValue & mask)) return { blocked: true, reason };
    }
    return { blocked: false };
  }

  if (family === 6) {
    const bytes = ipv6ToBytes(address.toLowerCase().replace(/^\[|\]$/g, ''));
    if (bytes === null) return { blocked: true, reason: 'unparseable address' };
    const zeroUpTo = (end: number) => bytes.slice(0, end).every((byte) => byte === 0);
    const embeddedV4 = () => bytes.slice(12).join('.');

    if (zeroUpTo(16)) return { blocked: true, reason: 'unspecified' };
    if (zeroUpTo(15) && bytes[15] === 1) return { blocked: true, reason: 'loopback' };
    // IPv4-mapped (`::ffff:169.254.169.254`) is the classic bypass, and `new
    // URL` rewrites it to hex (`[::ffff:7f00:1]`) before we ever see it — so the
    // judgement is on the bytes, never on a spelling. The deprecated
    // IPv4-compatible `::a.b.c.d` (`::/96`) embeds one the same way.
    if (zeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return classifyAddress(embeddedV4());
    }
    if (zeroUpTo(12)) return classifyAddress(embeddedV4());
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
    if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return { blocked: true, reason: 'link-local' };
    if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return { blocked: true, reason: 'site-local' };
    if ((b0 & 0xfe) === 0xfc) return { blocked: true, reason: 'unique local' };
    if (b0 === 0xff) return { blocked: true, reason: 'multicast' };
    if (b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b) {
      return { blocked: true, reason: 'NAT64' };
    }
    if (b0 === 0x20 && b1 === 0x02) return { blocked: true, reason: '6to4' };
    return { blocked: false };
  }

  return { blocked: true, reason: 'not an IP address' };
}

/**
 * `URL.hostname` keeps the brackets around an IPv6 literal (`[::1]`), and
 * `isIP` does not accept them — so an unnormalised host would slip past the
 * literal-address check and be handed to the resolver instead.
 */
function normaliseHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
}

/** Hostnames that resolve to loopback on purpose and are not worth arguing with. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

function judgeUrl(
  raw: string,
  allowedPorts: readonly number[],
  allowHttp: boolean,
  judgeAddress: (address: string) => AddressVerdict,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('refused', 'not a URL');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new SafeFetchError('refused', `scheme ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError('refused', 'credentials in URL');
  }
  const host = normaliseHost(url.hostname);
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SafeFetchError('refused', 'loopback hostname');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443 && !allowedPorts.includes(port)) {
    throw new SafeFetchError('refused', `port ${port}`);
  }
  // A literal IP is judged here; a name is judged after resolution.
  if (isIP(host) !== 0) {
    const verdict = judgeAddress(host);
    if (verdict.blocked) throw new SafeFetchError('refused', verdict.reason);
  }
  return url;
}

async function resolveAndJudge(
  hostname: string,
  resolver: (hostname: string) => Promise<string[]>,
  judgeAddress: (address: string) => AddressVerdict,
): Promise<string> {
  const host = normaliseHost(hostname);
  if (isIP(host) !== 0) return host;

  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new SafeFetchError('failed', 'DNS lookup failed');
  }
  if (addresses.length === 0) throw new SafeFetchError('failed', 'no addresses');

  // *Every* answer must be public. A name that resolves to one public and one
  // private address is a rebinding attempt, not a multi-homed CDN.
  for (const address of addresses) {
    const verdict = judgeAddress(address);
    if (verdict.blocked) throw new SafeFetchError('refused', verdict.reason);
  }
  return addresses[0]!;
}

async function systemResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// the fetch
// ---------------------------------------------------------------------------

export async function safeFetch(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const allowedPorts = options.allowedPorts ?? [];
  const allowHttp = options.allowHttp ?? false;
  const resolver = options.resolve ?? systemResolve;
  const transport = options.transport ?? pinnedTransport();
  const judgeAddress = options.judgeAddress ?? classifyAddress;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    let current = raw;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = judgeUrl(current, allowedPorts, allowHttp, judgeAddress);
      // Each hop is pinned to *its own* judged address: nothing from the
      // previous hop's verdict is reused.
      const address = await resolveAndJudge(url.hostname, resolver, judgeAddress);

      let response: Response;
      try {
        response = await transport({
          url,
          address,
          signal: controller.signal,
          headers: {
            accept: '*/*',
            'user-agent': 'x-zoo/1.0 (+attachment import)',
          },
        });
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError('failed', 'request failed');
      }

      if (response.status >= 300 && response.status < 400) {
        await discard(response);
        const location = response.headers.get('location');
        if (!location) throw new SafeFetchError('failed', 'redirect without Location');
        current = new URL(location, url).toString();
        continue;
      }

      if (!response.ok) {
        await discard(response);
        throw new SafeFetchError('failed', `status ${response.status}`);
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await discard(response);
        throw new SafeFetchError('failed', 'too large');
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBounded(response, maxBytes);
      } catch (error) {
        // A reset or the timeout mid-body is a failed fetch, not a 500.
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError('failed', 'request failed');
      }
      return {
        bytes,
        contentType: response.headers.get('content-type') ?? undefined,
        url: url.toString(),
      };
    }
    throw new SafeFetchError('failed', 'too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// the transport: the judged address, under the real name
// ---------------------------------------------------------------------------

/**
 * A `lookup` that answers every question with the one address that was judged.
 *
 * `net.connect` asks it instead of DNS, so the socket goes to that address and
 * no other — there is no second resolution for a rebinding server to win —
 * while everything above the socket still sees the hostname. Node asks for
 * either one address or, with `autoSelectFamily`, a list; both get the same.
 */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (error: null, address: unknown, family?: number) => void,
  ) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as LookupFunction;
}

/**
 * The production transport: `node:http` / `node:https`, dialling the judged
 * address with the URL's own hostname everywhere else.
 *
 * - `Host` is the hostname, as Node writes it from the URL;
 * - SNI is the hostname, so a CDN fronting many sites can choose a
 *   certificate;
 * - the certificate is verified — against the system CAs, for the hostname —
 *   exactly as for any other request. There is no switch here that turns that
 *   off (TLS-001); `ca` adds a trust anchor for a test server and replaces
 *   nothing else.
 * - `agent: false`: a fresh connection per hop, so a pooled socket to some
 *   other address can never be reused for this one.
 *
 * Not `fetch`: its connection layer (undici's) takes the address from the URL,
 * and making it take a pinned one needs a dispatcher from a second copy of
 * undici whose version would have to track Node's own.
 */
export function pinnedTransport(tls: { ca?: string | string[] } = {}): Transport {
  return (request) =>
    new Promise<Response>((resolve, reject) => {
      const { url } = request;
      const secure = url.protocol === 'https:';
      const host = normaliseHost(url.hostname);
      const common = {
        hostname: host,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: request.headers,
        lookup: pinnedLookup(request.address),
        signal: request.signal,
        agent: false as const,
      };
      const onResponse = (incoming: IncomingMessage): void => resolve(toResponse(incoming));
      const outgoing = secure
        ? httpsRequest(
            {
              ...common,
              // SNI must be a name; for an IP-literal URL there is none to send.
              ...(isIP(host) === 0 ? { servername: host } : {}),
              ...(tls.ca === undefined ? {} : { ca: tls.ca }),
            },
            onResponse,
          )
        : httpRequest(common, onResponse);
      outgoing.on('error', reject);
      outgoing.end();
    });
}

/** Statuses whose `Response` may not carry a body. */
const NULL_BODY = new Set([204, 205, 304]);

function toResponse(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const status = incoming.statusCode ?? 502;
  if (NULL_BODY.has(status) || status < 200 || status > 599) {
    incoming.resume();
    return new Response(null, { status: NULL_BODY.has(status) ? status : 502, headers });
  }
  const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

/**
 * Reads the body, stopping at `maxBytes`.
 *
 * Not `await response.arrayBuffer()`: that buffers whatever the server decides
 * to send, and `Content-Length` is a claim, not a promise.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new SafeFetchError('failed', 'too large');
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new SafeFetchError('failed', 'too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
