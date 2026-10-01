import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * An HTTPS server nobody trusts, for TLS-001.
 *
 * A self-signed certificate for `localhost` (SAN `DNS:localhost`,
 * `IP:127.0.0.1`), minted per process from a fresh RSA key by a small DER
 * builder, so no key material lives in the repository. Every outbound WeChat
 * client is pointed at it and must refuse **at the handshake**: `received`
 * stays empty, which is what shows the request — and whatever credential it
 * carried on its query string — never left the process.
 *
 * `startHttpsServer` is the same thing with a caller's handler and names, for a
 * test that needs a TLS peer it *can* trust: `safeFetch`'s real transport.
 *
 * Test support only; imported by `*.tls.test.ts` files and nothing else.
 */

// --- a self-signed certificate, DER by hand ----------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const utcTime = (at: Date): Buffer =>
  tlv(0x17, Buffer.from(`${at.toISOString().slice(2, 19).replace(/[-T:]/g, '')}Z`, 'ascii'));
const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));

function integer(value: number): Buffer {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  if (bytes.length === 0 || bytes[0]! >= 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a! * 40 + b!];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let n = arc >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/**
 * A self-signed certificate for `hosts` (DNS SANs; the first is also the CN),
 * plus `IP:127.0.0.1` unless `ipSan: false` — a certificate that names only DNS
 * names is what a real CDN presents, and what a client that dials an IP literal
 * fails to validate.
 */
export function selfSigned(
  key: { privateKey: KeyObject; publicKey: KeyObject },
  hosts: string | readonly string[],
  at: Date,
  options: { ipSan?: boolean | undefined } = {},
): string {
  const names = typeof hosts === 'string' ? [hosts] : hosts;
  const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(names[0] ?? 'localhost'))));
  const now = at.getTime();
  const altNames = names.map((host) => tlv(0x82, Buffer.from(host, 'ascii')));
  if (options.ipSan !== false) altNames.push(tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const subjectAltName = seq(oid('2.5.29.17'), tlv(0x04, seq(...altNames)));
  const tbs = seq(
    explicit(0, integer(2)),
    integer(now % 1_000_000_000),
    sha256WithRsa,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 3_600_000))),
    name,
    key.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(subjectAltName)),
  );
  const signature = createSign('RSA-SHA256').update(tbs).sign(key.privateKey);
  const der = seq(tbs, sha256WithRsa, bitString(signature));
  // 64-column lines, and no empty one when the length is a multiple of 64 —
  // OpenSSL refuses a PEM with a blank line in it.
  const body = (der.toString('base64').match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

// --- the untrusted server ----------------------------------------------------

export interface UntrustedHttpsServer {
  /** `https://localhost:<port>` — the name the certificate is for. */
  url: string;
  port: number;
  /** `METHOD /path?query` of every request that got past the handshake. */
  received: string[];
  /** The PEM a control client may be told to trust. */
  certificate: string;
  /** The key pair behind the certificate, for a client that needs one (the pay client signs). */
  privateKeyPem: string;
  publicKeyPem: string;
  publicKey: KeyObject;
  close(): Promise<void>;
}

/**
 * Answers `200 {}` to anything that completes a handshake. `now` dates the
 * certificate (valid from a minute before to a day after), so it is the test's
 * wall clock — the one a real TLS stack will judge it by.
 */
export async function startUntrustedHttpsServer(now: Date): Promise<UntrustedHttpsServer> {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certificate = selfSigned(key, 'localhost', now);
  const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const received: string[] = [];

  const server: Server = createServer({ key: privateKeyPem, cert: certificate }, (req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `https://localhost:${port}`,
    port,
    received,
    certificate,
    privateKeyPem,
    publicKeyPem,
    publicKey: key.publicKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- a TLS server for a named host, with the caller's handler ------------------

export interface NamedHttpsServer {
  port: number;
  /** The PEM a client must be told to trust. */
  certificate: string;
  /** The SNI name of every connection that completed a handshake, in order. */
  servernames: Array<string | false | null>;
  close(): Promise<void>;
}

/**
 * An HTTPS server on 127.0.0.1 whose certificate names `hosts` — DNS names
 * only unless `ipSan` — answering with `handler`.
 */
export async function startHttpsServer(options: {
  now: Date;
  hosts: readonly string[];
  ipSan?: boolean;
  /** The loopback address to listen on; `127.0.0.1` unless a test needs two. */
  bind?: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}): Promise<NamedHttpsServer> {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certificate = selfSigned(key, options.hosts, options.now, { ipSan: options.ipSan });
  const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const servernames: Array<string | false | null> = [];

  const server: Server = createServer({ key: privateKeyPem, cert: certificate }, (req, res) => {
    servernames.push((req.socket as TLSSocket).servername);
    options.handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, options.bind ?? '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    certificate,
    servernames,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
