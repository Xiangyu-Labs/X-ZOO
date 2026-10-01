import type Redis from 'ioredis';
import type { Ctx } from '../kernel/context';

/**
 * The SSE producer.
 *
 * The admin header bell listens on `/admin-api/notifications/stream` with a raw
 * `EventSource`; this is the other half. The route handler subscribes to one
 * Redis channel per admin and forwards whatever arrives; the fan-out publishes
 * to it **after** the transaction that wrote the row has committed.
 *
 * ## Why a channel per admin, and not one channel with a recipient field
 *
 * A shared channel would deliver every admin's notifications to every connected
 * node, which then filters — so the filter is what enforces "an operator who
 * cannot see refunds is not told about one", and a filter is a thing you can
 * forget. Per-admin channels push that decision to the one place that already
 * makes it: the recipient query in `findAdminRecipients`. Redis handles tens of
 * thousands of channels without noticing.
 *
 * ## Why Pub/Sub and not a stream
 *
 * Pub/Sub is fire-and-forget: an admin with no browser open misses the push,
 * and that is correct, because the durable copy is the `notification_messages`
 * row the bell reads on connect. Making the push durable would give us two
 * sources of truth for the same badge.
 *
 * ## Why this file talks to Redis directly
 *
 * It is not a `*.repo.ts`, so it may not touch Drizzle — and it does not. Redis
 * is on `Ctx` for exactly this kind of use (the rate limiter and the config
 * cache do the same).
 */

/** Matches `adminNotification` in `apps/web/src/admin/notifications/types.ts`. */
export interface AdminStreamEvent {
  id: string;
  /** Domain-ish discriminator the bell uses for the icon, e.g. `admin_order_paid`. */
  type: string;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
}

export function adminChannel(adminId: number): string {
  return `notifications:admin:${adminId}`;
}

/**
 * Publishes one event to one admin.
 *
 * Never throws. A Redis hiccup must not fail the effect that wrote the durable
 * message: the bell re-reads the inbox on its next connect, so a dropped push
 * costs a few seconds of latency and nothing else. Failing the effect would
 * instead re-run the whole fan-out and risk a second WeChat message for a
 * notification that was already delivered.
 */
export async function publishToAdmin(
  ctx: Ctx,
  adminId: number,
  event: AdminStreamEvent,
): Promise<void> {
  try {
    await ctx.redis.publish(adminChannel(adminId), JSON.stringify(event));
  } catch (error) {
    ctx.logger.warn({ err: error, adminId }, 'notification stream publish failed');
  }
}

/**
 * How many bell streams one admin may hold open **in one web process**. A tab
 * holds one; eight is more tabs than anybody works in, and a loop opening
 * streams with a stolen or valid cookie stops there instead of at the process's
 * file-descriptor limit.
 */
export const MAX_STREAMS_PER_ADMIN = 8;

/** Thrown by `subscribeToAdmin` when the admin already holds the maximum. */
export class AdminStreamLimitError extends Error {
  constructor(readonly adminId: number) {
    super(`admin ${adminId} already holds ${MAX_STREAMS_PER_ADMIN} notification streams`);
    this.name = 'AdminStreamLimitError';
  }
}

interface ChannelEntry {
  listeners: Set<(raw: string) => void>;
  /** Resolves once Redis has confirmed the SUBSCRIBE. */
  ready: Promise<unknown>;
}

interface Hub {
  subscriber: Redis;
  channels: Map<string, ChannelEntry>;
}

/**
 * One subscriber connection per process (per base client), shared by every open
 * stream.
 *
 * With a `redis.duplicate()` per stream, any admin session could open
 * connections in a loop until Redis `maxclients` ran out — taking the sessions,
 * rate limits and the queue down with it. Shared, N tabs cost one connection,
 * the channels are reference-counted, and the connection is dropped when the
 * last stream closes.
 */
const hubs = new WeakMap<Redis, Hub>();

function hubFor(redis: Redis): Hub {
  const existing = hubs.get(redis);
  if (existing) return existing;
  // ioredis puts a connection into subscriber mode, where ordinary commands
  // are refused, so the hub duplicates the shared client rather than
  // borrowing it — the one mistake that turns a notification bell into an
  // outage of everything else that uses Redis.
  const subscriber = redis.duplicate();
  const hub: Hub = { subscriber, channels: new Map() };
  subscriber.on('message', (channel: string, payload: string) => {
    const entry = hub.channels.get(channel);
    if (!entry) return;
    for (const listener of entry.listeners) {
      try {
        listener(payload);
      } catch {
        // One broken stream must not starve the others on the same channel.
      }
    }
  });
  hubs.set(redis, hub);
  return hub;
}

/**
 * Subscribes to one admin's channel through the process's shared subscriber.
 *
 * Throws `AdminStreamLimitError` when the admin already holds
 * `MAX_STREAMS_PER_ADMIN` streams here. Returns an unsubscribe function; the
 * route handler calls it when the response stream is cancelled, which Next
 * signals through `request.signal`, or when the session stops resolving.
 */
export async function subscribeToAdmin(
  redis: Redis,
  adminId: number,
  onEvent: (raw: string) => void,
  options: { maxPerAdmin?: number } = {},
): Promise<() => Promise<void>> {
  const hub = hubFor(redis);
  const channel = adminChannel(adminId);
  const max = options.maxPerAdmin ?? MAX_STREAMS_PER_ADMIN;

  let entry = hub.channels.get(channel);
  if (entry && entry.listeners.size >= max) throw new AdminStreamLimitError(adminId);
  if (!entry) {
    entry = { listeners: new Set(), ready: hub.subscriber.subscribe(channel) };
    hub.channels.set(channel, entry);
  }
  // A private wrapper, so the same callback subscribed twice is two streams.
  const listener = (raw: string): void => onEvent(raw);
  entry.listeners.add(listener);
  const mine = entry;

  let released = false;
  async function release(): Promise<void> {
    if (released) return;
    released = true;
    mine.listeners.delete(listener);
    if (mine.listeners.size > 0 || hub.channels.get(channel) !== mine) return;
    hub.channels.delete(channel);
    if (hub.channels.size === 0 && hubs.get(redis) === hub) {
      // The last stream in this process closed: drop the connection. The next
      // stream opens a fresh hub.
      hubs.delete(redis);
      hub.subscriber.disconnect();
      return;
    }
    await hub.subscriber.unsubscribe(channel).catch(() => undefined);
  }

  try {
    await mine.ready;
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/** How many streams this process holds for one admin. For tests and `/readyz`-style probes. */
export function openAdminStreams(redis: Redis, adminId: number): number {
  return hubs.get(redis)?.channels.get(adminChannel(adminId))?.listeners.size ?? 0;
}
