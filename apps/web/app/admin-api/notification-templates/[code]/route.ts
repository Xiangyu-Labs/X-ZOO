import {
  notificationAdminTemplateDetail,
  notificationAdminTemplateUpdate,
} from '@shop/contracts/notification/notification.admin.contract';
import { notificationAdmin } from '@shop/core/notification';
import { handle } from '../../../../src/server';

export const GET = handle(notificationAdminTemplateDetail, (ctx, { params }) =>
  notificationAdmin.getTemplate(ctx, params),
);

export const PUT = handle(notificationAdminTemplateUpdate, async (ctx, { params, body }) => {
  const saved = await notificationAdmin.saveTemplate(ctx, params, body);
  // The code is the template's identity — there is no surrogate id — so it is
  // what the audit row has to carry.
  ctx.audit(`notification-template:${params.code}`);
  return saved;
});

export const dynamic = 'force-dynamic';
