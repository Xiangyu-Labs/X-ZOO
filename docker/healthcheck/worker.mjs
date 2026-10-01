#!/usr/bin/env node
// Container healthcheck for the `worker` image.
//
// The worker has no HTTP surface, so the usual probe — a real request through
// the pool — is not available. What it does have is the heartbeat
// `apps/worker/src/main.ts` refreshes every `HEARTBEAT_INTERVAL_MS` from the
// same event loop that runs the jobs, with a TTL of four intervals, and which
// it deletes *before* draining on SIGTERM.
//
// So the probe is: read `worker:heartbeat` and require it to be recent. Not
// `EXISTS` — the TTL alone would let a worker whose loop wedged look healthy
// for a full minute, and a key written once at boot by a process that then
// stopped beating would look healthy until the TTL expired. The value is the
// millisecond timestamp of the last beat, so freshness is checkable directly.
//
// Zero dependencies: the runtime image carries the worker bundle and its four
// external packages, and adding `redis-cli` would mean a second base image.
// RESP2 is small enough to speak over a socket.
import { connect } from 'node:net';
import { once } from 'node:events';

const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const key = process.env.HEARTBEAT_KEY ?? 'worker:heartbeat';
const intervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS ?? '15000');
// Two missed beats is a wedged loop; one is a slow tick. The TTL the worker
// sets is four intervals, so this probe is deliberately stricter than the key's
// own expiry.
const maxAgeMs = Number(process.env.HEARTBEAT_MAX_AGE_MS ?? String(intervalMs * 3));
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? '4000');

function fail(message) {
  process.stderr.write(`worker healthcheck: ${message}\n`);
  process.exit(1);
}

/** RESP2 command encoder: `*<n>\r\n$<len>\r\n<arg>\r\n…`. */
function command(...args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  return out;
}

/**
 * Pulls one reply off the front of `buffer`.
 * Returns `null` while the reply is incomplete, so the caller can wait for more
 * bytes rather than mis-parse a split packet.
 */
function readReply(buffer) {
  const end = buffer.indexOf('\r\n');
  if (end === -1) return null;
  const head = buffer.subarray(1, end).toString('latin1');
  const kind = String.fromCharCode(buffer[0]);
  const rest = buffer.subarray(end + 2);
  if (kind === '+') return { value: head, rest };
  if (kind === '-') return { value: null, error: head, rest };
  if (kind === ':') return { value: head, rest };
  if (kind === '$') {
    const length = Number(head);
    if (length === -1) return { value: null, rest };
    if (rest.length < length + 2) return null;
    return { value: rest.subarray(0, length).toString('utf8'), rest: rest.subarray(length + 2) };
  }
  return { value: null, error: `unsupported reply type ${kind}`, rest };
}

const socket = connect({
  host: url.hostname,
  port: Number(url.port || '6379'),
  timeout: timeoutMs,
});
socket.on('timeout', () => socket.destroy(new Error(`no answer within ${timeoutMs}ms`)));

const commands = [];
if (url.password)
  commands.push(command('AUTH', ...(url.username ? [url.username] : []), url.password));
const database = url.pathname.replace('/', '');
if (database) commands.push(command('SELECT', database));
commands.push(command('GET', key));

try {
  await once(socket, 'connect');
  socket.write(commands.join(''));

  let buffer = Buffer.alloc(0);
  const replies = [];
  while (replies.length < commands.length) {
    for (;;) {
      const reply = readReply(buffer);
      if (!reply) break;
      buffer = reply.rest;
      replies.push(reply);
      if (replies.length === commands.length) break;
    }
    if (replies.length === commands.length) break;
    const [chunk] = await once(socket, 'data');
    buffer = Buffer.concat([buffer, chunk]);
  }
  socket.end();

  const failed = replies.find((reply) => reply.error);
  if (failed) fail(`redis said: ${failed.error}`);

  const beat = replies[replies.length - 1].value;
  if (beat === null) fail(`${key} is missing — the worker is not beating`);

  const age = Date.now() - Number(beat);
  if (!Number.isFinite(age)) fail(`${key} does not hold a timestamp: ${beat}`);
  if (age > maxAgeMs) fail(`${key} is ${age}ms old (max ${maxAgeMs}ms)`);
  // A clock that runs backwards is a real fault, not a healthy worker.
  if (age < -maxAgeMs) fail(`${key} is ${-age}ms in the future; check the clocks`);

  process.stdout.write(`ok age=${age}ms\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
