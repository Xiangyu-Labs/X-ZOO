import {
  catalogAdminReviewReply,
  catalogAdminReviewReplyUpdate,
} from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/admin-api/catalog/reviews/:id/reply` — 回复, and editing that reply.
 *
 * POST creates and refuses a second one; PUT edits what is there. The split is
 * what makes the first reply a conditional update, so two operators answering
 * the same review at once cannot overwrite each other silently.
 */

export const POST = handle(catalogAdminReviewReply, async (ctx, { params, body }) => {
  const replied = await catalog.adminReviewReply(ctx, params, body);
  ctx.audit(`review:${params.id}`);
  return replied;
});

export const PUT = handle(catalogAdminReviewReplyUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminReviewReplyUpdate(ctx, params, body);
  ctx.audit(`review:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
