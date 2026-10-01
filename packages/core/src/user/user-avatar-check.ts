import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import type { MediaRiskHandler } from '../wechat';
import * as repo from './user.repo';

/**
 * 内容安全 (C09, CONTENT-005): WeChat's `wxa_media_check` called an avatar
 * `risky`. The default avatar comes back — only while the account still shows
 * that picture — and the customer is told.
 *
 * Telling is the notification domain's job, and it cannot be imported from
 * here (`notification` → `order` → `user` would close a cycle), so the notice
 * crosses as a listener `notification` installs from its own registrar, the
 * same way it hears about orders.
 */

/** The in-app notice's event code (registered with the built-in events). */
export const AVATAR_REJECTED_EVENT = 'user_avatar_rejected';

export interface AvatarRejectedEvent {
  userId: number;
  /** The `content_security_checks` row, which keys the notice. */
  checkId: number;
}

export type AvatarRejectedListener = (
  tx: Tx,
  ctx: Ctx,
  event: AvatarRejectedEvent,
) => Promise<void>;

let listener: AvatarRejectedListener | undefined;

/** Idempotent: the last registration wins. */
export function onAvatarRejected(fn: AvatarRejectedListener): void {
  listener = fn;
}

export const resetRiskyAvatar: MediaRiskHandler = async (tx, ctx, input) => {
  const reset = await repo.resetAvatarIf(tx, {
    id: input.subjectId,
    url: input.mediaUrl,
    now: ctx.clock.now(),
  });
  if (!reset.won) return 'none';
  await listener?.(tx, ctx, { userId: input.subjectId, checkId: input.checkId });
  return 'avatar_reset';
};
