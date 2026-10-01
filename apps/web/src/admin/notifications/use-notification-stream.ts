'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  notificationAdminInboxList,
  notificationAdminMarkAllRead,
  notificationAdminMarkRead,
  notificationAdminUnreadCount,
} from '@shop/contracts/notification/notification.admin.contract';
import type { NotificationMessage } from '@shop/contracts/notification/schemas';

import { callRoute } from '../api';
import { adminNotification, type AdminNotification, type StreamStatus } from './types';

export interface NotificationStreamOptions {
  /** Set `false` to keep the stream closed (e.g. while signed out). */
  enabled?: boolean | undefined;
  /** How many notifications to keep in memory. Default 50. */
  limit?: number | undefined;
  /** First backoff step in ms. Default 1000, doubling up to `maxDelay`. */
  baseDelay?: number | undefined;
  maxDelay?: number | undefined;
  /**
   * Consecutive failures *without ever connecting* before the hook goes
   * dormant. Default 5 — that is the "tolerate a 404 for now" behaviour: the
   * endpoint does not exist during Phase 0, so stop hammering it.
   */
  coldFailureLimit?: number | undefined;
  /**
   * Read the durable inbox on mount and after every reconnect, and send
   * mark-read to the server. Default `true`; the kit demo turns it off.
   */
  syncInbox?: boolean | undefined;
}

export interface NotificationStream {
  notifications: AdminNotification[];
  unreadCount: number;
  status: StreamStatus;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** Force an immediate reconnect after the hook went dormant. */
  reconnect: () => void;
}

/**
 * The header bell's state: the durable inbox, plus live pushes over SSE.
 *
 * - **Seeded from the inbox**. On mount, and again whenever the
 *   stream re-opens after a drop, the hook reads the unread rows
 *   (`GET /admin-api/notifications?unreadOnly=true`) and the unread count. A
 *   notification written while the operator was on another tab, or before they
 *   signed in, is therefore on the bell when they arrive.
 * - **Pushes are named events.** The server writes `event: notification`,
 *   which reaches `addEventListener('notification')` and never `onmessage`
 *   (the listener the hook used to set, so the bell dropped every push). The
 *   push carries the inbox row's id, so a row that is both seeded and pushed
 *   shows once.
 * - **Reading is a server write.** `markRead` / `markAllRead` update the badge
 *   at once and call the inbox routes; the next load agrees.
 *
 * The connection is a raw `EventSource` rather than `callRoute` because SSE is
 * a long-lived stream, not a request/response: it carries no contract body and
 * cannot be modelled by a `RouteDef`. Everything else goes through `callRoute`.
 */
export function useNotificationStream(
  url: string,
  options: NotificationStreamOptions = {},
): NotificationStream {
  const {
    enabled = true,
    limit = 50,
    baseDelay = 1000,
    maxDelay = 30_000,
    coldFailureLimit = 5,
    syncInbox = true,
  } = options;

  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Unread rows the server has that the list does not hold (beyond `limit`). */
  const [unlisted, setUnlisted] = useState(0);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [generation, setGeneration] = useState(0);

  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    let disposed = false;
    let attempt = 0;
    let everOpened = false;

    const clearTimer = (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const seed = async (): Promise<void> => {
      if (!syncInbox) return;
      try {
        const [page, count] = await Promise.all([
          callRoute(notificationAdminInboxList, {
            query: { page: 1, pageSize: Math.min(limit, 100), unreadOnly: 'true' },
          }),
          callRoute(notificationAdminUnreadCount),
        ]);
        if (disposed) return;
        const seeded = page.items.map(fromInbox);
        setNotifications((current) => {
          const known = new Set(seeded.map((item) => item.id));
          const merged = [...current.filter((item) => !known.has(item.id)), ...seeded];
          merged.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          return merged.slice(0, limit);
        });
        // Anything seeded is unread on the server right now.
        setReadIds((current) => {
          if (!seeded.some((item) => current.has(item.id))) return current;
          const next = new Set(current);
          for (const item of seeded) next.delete(item.id);
          return next;
        });
        setUnlisted(Math.max(0, count.unread - seeded.length));
      } catch {
        // The bell is a convenience: a failed read leaves whatever it shows,
        // and the next reconnect tries again. A 401 is handled by `callRoute`.
      }
    };

    const connect = (): void => {
      if (disposed) return;
      setStatus('connecting');

      const source = new EventSource(url, { withCredentials: true });
      sourceRef.current = source;

      source.onopen = () => {
        if (disposed) return;
        // A re-open after a drop may have missed pushes: read the inbox again.
        if (attempt > 0) void seed();
        everOpened = true;
        attempt = 0;
        setStatus('open');
      };

      source.addEventListener('notification', (event: MessageEvent<string>) => {
        const parsed = parseEvent(event.data);
        if (!parsed) return;
        setNotifications((prev) => {
          if (prev.some((item) => item.id === parsed.id)) return prev;
          return [parsed, ...prev].slice(0, limit);
        });
      });

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        if (disposed) return;

        attempt += 1;
        // `EventSource` hides the HTTP status, so "never opened, keeps failing"
        // is the only signal that the endpoint isn't there yet.
        if (!everOpened && attempt >= coldFailureLimit) {
          setStatus('unavailable');
          return;
        }
        setStatus('connecting');
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        const jittered = delay * (0.5 + Math.random() * 0.5);
        clearTimer();
        timerRef.current = setTimeout(connect, jittered);
      };
    };

    void seed();
    connect();

    return () => {
      disposed = true;
      clearTimer();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [url, enabled, limit, baseDelay, maxDelay, coldFailureLimit, syncInbox, generation]);

  const markRead = useCallback(
    (id: string) => {
      setReadIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      if (syncInbox) {
        callRoute(notificationAdminMarkRead, { params: { id }, body: {} }).catch(() => undefined);
      }
    },
    [syncInbox],
  );

  const markAllRead = useCallback(() => {
    setNotifications((current) => {
      setReadIds(new Set(current.map((item) => item.id)));
      return current;
    });
    setUnlisted(0);
    if (syncInbox) {
      callRoute(notificationAdminMarkAllRead, { body: {} }).catch(() => undefined);
    }
  }, [syncInbox]);

  const reconnect = useCallback(() => setGeneration((n) => n + 1), []);

  const unreadCount = useMemo(
    () =>
      unlisted +
      notifications.reduce((count, item) => (readIds.has(item.id) ? count : count + 1), 0),
    [notifications, readIds, unlisted],
  );

  return { notifications, unreadCount, status, markRead, markAllRead, reconnect };
}

function parseEvent(raw: string): AdminNotification | null {
  try {
    const parsed = adminNotification.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** An inbox row in the shape the bell renders; the same shape the push carries. */
function fromInbox(message: NotificationMessage): AdminNotification {
  const link = message.data?.['link'];
  return {
    id: message.id,
    type: message.code ?? 'broadcast',
    title: message.title,
    body: message.content,
    ...(typeof link === 'string' && link !== '' ? { link } : {}),
    createdAt: message.createdAt,
  };
}
