import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';

/**
 * 注销 reaches past `users`. Other domains keep their own frozen copy of who
 * did something — a review's author, a team member's nickname and face — and
 * that copy is shown to other shoppers long after the account is gone.
 *
 * This domain may not touch their tables (and `catalog` → `order` → `user`
 * means it cannot import them either), so each owner installs a listener from
 * its own registrar, the same way `notification` hears `onAvatarRejected`.
 * The listeners run inside the approval's transaction: one that fails rolls
 * the approval back, and the request stays 待审核 rather than half-forgotten.
 */

export interface AccountCancelledEvent {
  userId: number;
}

export type AccountCancelledListener = (
  tx: Tx,
  ctx: Ctx,
  event: AccountCancelledEvent,
) => Promise<void>;

const listeners = new Map<string, AccountCancelledListener>();

/** Idempotent: the last registration under a `name` (the owning domain) wins. */
export function onAccountCancelled(name: string, fn: AccountCancelledListener): void {
  listeners.set(name, fn);
}

export async function announceAccountCancelled(
  tx: Tx,
  ctx: Ctx,
  event: AccountCancelledEvent,
): Promise<void> {
  for (const listener of listeners.values()) await listener(tx, ctx, event);
}
