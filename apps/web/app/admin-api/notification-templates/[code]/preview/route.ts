import { notificationAdminTemplatePreview } from '@shop/contracts/notification/notification.admin.contract';
import { notificationPreview } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

/** Renders the unsaved form with sample values. Writes nothing, so nothing to audit. */
export const POST = handle(notificationAdminTemplatePreview, (ctx, { params, body }) =>
  notificationPreview.preview(ctx, params, body),
);

export const dynamic = 'force-dynamic';
