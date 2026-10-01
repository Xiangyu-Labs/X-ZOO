import type { RouteId } from '@shop/api-client';
import type { StorefrontRoute } from '@shop/api-client/routes';
import { parseLoginRedirect } from '@/platform';

/**
 * Reads a message change makes stale (read, all read, deleted): the list, the 我的 badge, the
 * message itself. The same on 消息中心 and 消息详情, which sit on top of each other.
 */
export const MESSAGE_READS: readonly RouteId[] = [
  'notification.myList',
  'notification.myUnreadCount',
  'notification.myDetail',
];

/**
 * Where a message leads (pages.md §4): `data.route` is a `{ route, params }` from the route
 * catalogue (H2, NOTIF-006). Anything else — no route, a key this client does not know, a
 * malformed value — is `null`, and the message opens its own detail page instead.
 *
 * The check is the login redirect's (a catalogue route, declared params only, never `login`).
 */
export function messageRoute(
  data: Readonly<Record<string, unknown>> | null,
): StorefrontRoute | null {
  const route = data?.['route'];
  if (typeof route !== 'object' || route === null) return null;
  return parseLoginRedirect(JSON.stringify(route));
}
