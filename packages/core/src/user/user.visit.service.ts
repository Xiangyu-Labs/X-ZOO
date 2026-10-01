import type { VisitBody } from '@shop/contracts/user/schemas';
import type { ClientPlatform } from '@shop/contracts/conventions';
import type { Ctx } from '../kernel/context';
import { fixedWindow } from '../kernel/rate-limit';
import { statsConfig } from '../stats';
import type { RequestMeta } from './storefront-auth.service';
import * as repo from './user.visit.repo';

/**
 * `POST /api/v1/visits` — the storefront page-view beacon.
 *
 * The only thing that fills `user_visits`; without it 访客数 reads 0. One
 * insert feeds every figure that reads the table, with no change in `stats`,
 * and the page's later hide report adds its time on screen to that same row.
 *
 * **Nothing here can throw.** A beacon is fired while the visitor is doing
 * something else; a refusal it could see would either be swallowed (making the
 * check pointless) or retried (making the flood worse). So the throttle drops
 * the row and returns, and the route answers 204 either way. The one thing the
 * caller *can* get wrong — a path with a query string in it — is caught by the
 * contract before this runs, because that one is a privacy bug rather than a
 * volume one.
 */

/**
 * One row per visitor, per path, per minute.
 *
 * The number is set by the mini program's `onShow`, which fires every time the
 * visitor comes back from a sub-page: browsing a category and tapping four
 * products would otherwise record five views of the category page in under a
 * minute. A minute is long enough to collapse that and short enough that a
 * visitor genuinely returning to a page through the day is still counted.
 *
 * 访客数 is a distinct count and is unaffected by the throttle; 浏览量 is the
 * figure this protects.
 */
const WINDOW_MS = 60_000;
const PER_WINDOW = 1;

/**
 * Rows one visitor may write per minute across **all** paths.
 *
 * The per-path window is keyed on a path the caller chooses, so on its own
 * varying the path turns the throttle off: a loop inserts one row per request
 * and sets 浏览量 to whatever it likes. Sixty distinct pages a minute is more
 * than a person browses; above it the beacon is dropped silently, exactly as a
 * per-path repeat is.
 */
const SUBJECT_PER_WINDOW = 60;

/** `wechat-mini` on the wire, `wechat_mini` in the enum — the same three values. */
function toColumnPlatform(
  platform: ClientPlatform | null,
): 'h5' | 'wechat_oa' | 'wechat_mini' | null {
  if (platform === null) return null;
  return platform === 'wechat-oa' ? 'wechat_oa' : platform === 'wechat-mini' ? 'wechat_mini' : 'h5';
}

/**
 * Who this beacon is throttled against.
 *
 * A signed-in visitor is their user id. Everybody else is their address —
 * `user_visits` has no session column, so the identity used for counting is the
 * same one `stats` already uses for 访客数: `coalesce(user_id, 'ip:' || ip)`.
 * That keeps the throttle and the figure talking about the same visitor instead
 * of two different notions of one.
 *
 * Behind a shared NAT this is coarser than a session id would be: a shopping
 * centre's wifi is one visitor for both the throttle and the figure. That is
 * the pre-existing definition of 访客数, not something the beacon introduces,
 * and a client-supplied session id would be worse — it is the one value a
 * caller can mint at will, so it would turn the throttle off for anybody who
 * bothered to randomise it.
 */
function subjectOf(ctx: Ctx, meta: RequestMeta): string {
  const userId = ctx.actor.kind === 'user' ? ctx.actor.id : null;
  if (userId !== null) return `u:${userId}`;
  return `ip:${meta.ip ?? 'unknown'}`;
}

/**
 * The most a single view is credited with, in milliseconds.
 *
 * A page left open on a desk, or a mini program parked in the background with
 * a page on top, is not a visitor reading it. Thirty minutes is the usual
 * session timeout of web analytics: past it the visitor has almost certainly
 * gone, and one forgotten tab should not move 平均停留时长 for the whole day.
 */
const STAY_CAP_MS = 30 * 60_000;

/**
 * How long the id of a visitor's latest view of a path is remembered, so the
 * page's hide report can find it. A report later than this finds nothing and
 * is dropped; by then the view is long past the cap anyway.
 */
const LAST_VIEW_TTL_SEC = 6 * 60 * 60;

/**
 * Stay reports one visitor may send per minute. One per view, plus the ones a
 * throttled re-show produces — twice the view ceiling covers both.
 */
const STAY_PER_WINDOW = 2 * SUBJECT_PER_WINDOW;

function lastViewKey(subject: string, path: string): string {
  return `visit:last:${subject}:${path}`;
}

export async function recordVisit(ctx: Ctx, body: VisitBody, meta: RequestMeta): Promise<void> {
  const subject = subjectOf(ctx, meta);
  if (body.stayMs !== undefined) {
    await recordStay(ctx, subject, body.path, body.stayMs);
    return;
  }

  const now = ctx.clock.now();
  const allowed = await fixedWindow(ctx.redis, {
    key: `visit:${subject}:${body.path}`,
    limit: PER_WINDOW,
    windowMs: WINDOW_MS,
    nowMs: now.getTime(),
  });
  if (!allowed.allowed) return;
  // Checked second, so a collapsed `onShow` re-fire does not spend the ceiling.
  const ceiling = await fixedWindow(ctx.redis, {
    key: `visit:${subject}`,
    limit: SUBJECT_PER_WINDOW,
    windowMs: WINDOW_MS,
    nowMs: now.getTime(),
  });
  if (!ceiling.allowed) return;

  const userId = ctx.actor.kind === 'user' ? ctx.actor.id : null;
  const id = await repo.insertVisit(ctx.db, {
    userId,
    path: body.path,
    // The body may say which storefront this is; `X-Client-Platform` is the
    // usual source and the fallback. Neither is trusted for anything but a
    // breakdown chart.
    platform: toColumnPlatform(body.platform ?? ctx.platform),
    ip: meta.ip ?? null,
    now,
  });
  await ctx.redis.set(lastViewKey(subject, body.path), String(id), 'EX', LAST_VIEW_TTL_SEC);
}

/**
 * The hide report: attaches `stayMs` to this visitor's latest recorded view of
 * the path.
 *
 * The view is found through Redis rather than by searching the table, because
 * an anonymous visitor is only an address and `user_visits` has no index that
 * would find "this address's latest view of this page" without scanning.
 * Keyed by the same subject as the throttle, so one visitor can only ever
 * credit their own views. A report with no view to attach to — the show was
 * never recorded, or the key expired — is dropped, silently like everything
 * else here.
 */
async function recordStay(ctx: Ctx, subject: string, path: string, stayMs: number): Promise<void> {
  const now = ctx.clock.now();
  const budget = await fixedWindow(ctx.redis, {
    key: `visit-stay:${subject}`,
    limit: STAY_PER_WINDOW,
    windowMs: WINDOW_MS,
    nowMs: now.getTime(),
  });
  if (!budget.allowed) return;

  const id = Number(await ctx.redis.get(lastViewKey(subject, path)));
  if (!Number.isSafeInteger(id) || id <= 0) return;
  await repo.addStay(ctx.db, { id, stayMs, capMs: STAY_CAP_MS, now });
}

/**
 * The retention sweep, called nightly by the worker: deletes page views older
 * than `stats.visitRetentionDays`. Batched, so a long-neglected table drains
 * over several nights rather than in one long transaction.
 */
export async function pruneVisits(
  ctx: Ctx,
  options: { limit?: number } = {},
): Promise<{ deleted: number }> {
  const { visitRetentionDays } = await ctx.config.get(statsConfig);
  const before = new Date(ctx.clock.now().getTime() - visitRetentionDays * 24 * 60 * 60 * 1000);
  const deleted = await ctx.withTx((tx) =>
    repo.pruneVisits(tx, { before, limit: options.limit ?? 5000 }),
  );
  return { deleted };
}
