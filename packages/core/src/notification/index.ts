/**
 * The `notification` domain's public surface.
 *
 * **One function is the whole contract for other domains:**
 *
 * ```ts
 * await notify(tx, ctx, {
 *   event: 'order_shipped',
 *   subject: { scope: 'order', id: orderId },
 *   userId,
 *   data: { orderNo, company, trackingNo },
 * });
 * ```
 *
 * Call it inside the business transaction. It writes one effect row and
 * returns; the dispatcher fans out to whichever channels the operator switched
 * on, after the commit. A failing channel therefore cannot fail an order, a
 * payment or a refund, and the ledger's `UNIQUE (scope, scope_id, event_type)`
 * means calling it twice for the same event and the same aggregate notifies
 * once.
 *
 * `registerNotificationEvents` is exported for the same reason the permission
 * registry is: a domain that owns an event owns its wording. Group-buy and
 * presale notices are registered from those domains' `index.ts`, not from this
 * domain's table.
 */

export {
  notify,
  notificationKey,
  NOTIFICATION_SCOPE,
  type NotifyInput,
} from './notification.service';

export {
  approvedRefundNote,
  settledRefundNote,
  registerNotificationEvents,
  findNotificationEvent,
  allNotificationEvents,
  type NotificationEvent,
  type NotificationRouteTemplate,
  type NotificationAudience,
} from './notification.registry';

export { formatShopTime } from './notification.render';

/** Whether a switched-on channel can send: what the list, the form and the save all ask. */
export { channelProblems, missingFields, describeRefusal } from './notification.channels';

export { registerSmsPort, type SmsPort, type SmsSendResult } from './notification.ports';

export { notificationConfig, type NotificationConfig } from './notification.config';
export { notificationPermissions } from './permissions';

/** The SSE endpoint's half; `apps/web` owns the route, this owns the subscription. */
export {
  subscribeToAdmin,
  adminChannel,
  openAdminStreams,
  AdminStreamLimitError,
  MAX_STREAMS_PER_ADMIN,
  type AdminStreamEvent,
} from './notification.stream';

// The surfaces the route files call.
export * as notificationAdmin from './notification.admin.service';
export * as notificationPreview from './notification.preview';
export * as notificationInbox from './notification.inbox.service';

import { registerBuiltInNotificationEvents } from './notification.registry';
import { installNotificationHooks } from './notification.effects';
import { registerDefaultSmsPort } from './notification.ports';
import { providerSmsPort } from './notification.sms';

/**
 * Idempotent, and the only place registration happens.
 *
 * `@shop/core/domains` calls it once per app at bootstrap. Registering from a
 * job or a route file makes the registration depend on which module a request
 * happened to load first, and an effect whose handler was not loaded yet parks
 * as `unknown`.
 */
export function registerNotificationDomain(): void {
  registerBuiltInNotificationEvents();
  installNotificationHooks();
  // The SMS channel sends through the provider 短信设置 names. Until this
  // existed nothing registered the port, and every SMS notice was skipped.
  registerDefaultSmsPort(providerSmsPort);
}
