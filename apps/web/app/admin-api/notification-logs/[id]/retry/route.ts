import { notificationAdminLogRetry } from '@shop/contracts/notification/notification.admin.contract';
import { notificationAdmin } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

/** Re-queues a parked send. The per-channel claims mean only the unsent channels go out again. */
export const POST = handle(notificationAdminLogRetry, async (ctx, { params }) => {
  const result = await notificationAdmin.retryLog(ctx, params);
  // The message, not the template: a retry is an act on one customer's
  // undelivered notification, and "which one did we send again" is the
  // question the log is read for.
  ctx.audit(`notification-log:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
