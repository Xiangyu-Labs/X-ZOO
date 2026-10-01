import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  notificationAdminInboxList,
  notificationAdminMarkAllRead,
  notificationAdminMarkRead,
  notificationAdminUnreadCount,
} from '@shop/contracts/notification/notification.admin.contract';

import { on, stubRoutes, type StubCall } from '@/test/api';

import { configureApi, resetApiConfig } from '../api';
import { useNotificationStream } from './use-notification-stream';

/**
 * The bell listens for the event the server names, reads the durable
 * inbox on mount, and marks read on the server.
 */

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: Listener | null = null;
  readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  /** What the server's `event: <type>\ndata: <data>` delivers. */
  emit(type: string, data: string): void {
    const event = new MessageEvent<string>(type, { data });
    if (type === 'message') this.onmessage?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const original = globalThis.EventSource;

let calls: StubCall[];
let inbox: { id: string; title: string; content: string; createdAt: string; code: string }[];
let unread: number;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  calls = [];
  inbox = [
    {
      id: '11',
      code: 'admin_refund_applied',
      title: '新的退款申请',
      content: '退款单 RF1 待处理',
      createdAt: '2026-09-23T08:00:00.000Z',
    },
  ];
  unread = 3;
  configureApi({ validateResponses: true });
  calls = stubRoutes([
    on(notificationAdminUnreadCount, () => ({ unread })),
    on(notificationAdminInboxList, () => ({
      items: inbox.map((item) => ({
        ...item,
        data: { link: '/admin/trade/refunds?detail=1' },
        readAt: null,
      })),
      total: inbox.length,
      page: 1,
      pageSize: 50,
    })),
    on(notificationAdminMarkRead, { marked: 1 }),
    on(notificationAdminMarkAllRead, { marked: 1 }),
  ]);
});

afterEach(() => {
  (globalThis as { EventSource: unknown }).EventSource = original;
  resetApiConfig();
});

describe('useNotificationStream', () => {
  it('seeds the bell from the unread inbox and the unread count on mount', async () => {
    const { result } = renderHook(() => useNotificationStream('/admin-api/notifications/stream'));
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0]).toMatchObject({
      id: '11',
      type: 'admin_refund_applied',
      body: '退款单 RF1 待处理',
      link: '/admin/trade/refunds?detail=1',
    });
    // Three unread on the server, one of them listed.
    expect(result.current.unreadCount).toBe(3);
    expect(calls.some((call) => call.url.includes('unreadOnly=true'))).toBe(true);
  });

  it('shows a push sent as a named `notification` event, once even when it is also seeded', async () => {
    const { result } = renderHook(() => useNotificationStream('/admin-api/notifications/stream'));
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit(
        'notification',
        JSON.stringify({
          id: '12',
          type: 'admin_order_paid',
          title: '新订单',
          body: '订单已付款',
          createdAt: '2026-09-23T09:00:00.000Z',
        }),
      );
    });
    expect(result.current.notifications.map((item) => item.id)).toEqual(['12', '11']);
    expect(result.current.unreadCount).toBe(4);

    // The seeded row pushed again is not a second notification.
    act(() => {
      source.emit(
        'notification',
        JSON.stringify({
          id: '11',
          type: 'admin_refund_applied',
          title: '新的退款申请',
          body: '退款单 RF1 待处理',
          createdAt: '2026-09-23T08:00:00.000Z',
        }),
      );
    });
    expect(result.current.unreadCount).toBe(4);

    // An unnamed message is not what the server sends, and is ignored.
    act(() => {
      source.emit(
        'message',
        JSON.stringify({ id: '99', type: 'x', title: 't', body: 'b', createdAt: 'c' }),
      );
    });
    expect(result.current.notifications.map((item) => item.id)).toEqual(['12', '11']);
  });

  it('marks one read, and all read, on the server', async () => {
    const { result } = renderHook(() => useNotificationStream('/admin-api/notifications/stream'));
    await waitFor(() => expect(result.current.unreadCount).toBe(3));

    act(() => result.current.markRead('11'));
    expect(result.current.unreadCount).toBe(2);
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', url: '/admin-api/notifications/11/read' }),
      ),
    );

    act(() => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(0);
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', url: '/admin-api/notifications/read-all' }),
      ),
    );
  });

  it('reads the inbox again when the stream re-opens after a drop', async () => {
    const { result } = renderHook(() =>
      useNotificationStream('/admin-api/notifications/stream', { baseDelay: 1, maxDelay: 1 }),
    );
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
    act(() => FakeEventSource.instances[0]!.onopen?.());
    const listReads = () => calls.filter((call) => call.url.includes('unreadOnly=true')).length;
    expect(listReads()).toBe(1);

    inbox.push({
      id: '13',
      code: 'admin_order_paid',
      title: '断线期间的订单',
      content: '订单已付款',
      createdAt: '2026-09-23T10:00:00.000Z',
    });
    unread = 4;
    act(() => FakeEventSource.instances[0]!.onerror?.());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    act(() => FakeEventSource.instances[1]!.onopen?.());

    await waitFor(() => expect(result.current.unreadCount).toBe(4));
    expect(listReads()).toBe(2);
    expect(result.current.notifications[0]!.id).toBe('13');
  });
});
