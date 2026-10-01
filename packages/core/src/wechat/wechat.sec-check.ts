import type { DbOrTx, Tx } from '@shop/db';
import type { ContentSecurityCheck } from './wechat.sec-check.repo';
import { recordEffect, registerEffectHandler, type Effect } from '../effects';
import type { Ctx } from '../kernel/context';
import { SummarizedError, UNEXPLAINED } from '../kernel/error-summary';
import { publicOrigin } from '../system';
import { getWechatClient } from './wechat.client';
import { wechatConfig } from './wechat.config';
import { MINI_PUSH_SCOPE } from './wechat.mini-push';
import { findOpenid } from './wechat.repo';
import { contentSecurityConfig } from './wechat.sec-check.config';
import * as checks from './wechat.sec-check.repo';

/**
 * 内容安全 (C09): WeChat's `msgSecCheck` for text and `mediaCheckAsync` for
 * pictures, and what the shop does with each answer.
 *
 * ## The policy, per kind of content
 *
 * | Content                         | Check                          | `pass`  | `review`   | `risky`                 | WeChat unavailable     |
 * | ------------------------------- | ------------------------------ | ------- | ---------- | ----------------------- | ---------------------- |
 * | review text                     | `msgSecCheck` scene 2, sync    | as configured | 待审核 | **待审核**, never refused | 待审核 (fail-safe)  |
 * | nickname                        | `msgSecCheck` scene 1, sync    | saved   | saved      | `USER_NICKNAME_REJECTED` | saved (fail-open)     |
 * | invoice-title name (book, order) | `msgSecCheck` scene 1, sync   | saved   | saved      | `…_TITLE_REJECTED`      | saved (fail-open)      |
 * | review picture                  | `mediaCheckAsync` scene 2, async | kept  | kept       | taken off the review    | kept; the ledger retries |
 *
 * A review that *cannot* be checked while the check is on — an account with no
 * mini-program openid, or a picture WeChat will not take (61010, no https
 * address) — is held in 待审核 too (CONTENT-006): "not checked" is not "passed".
 * | avatar                          | `mediaCheckAsync` scene 1, async | kept  | kept       | reset, and the user told | kept; the ledger retries |
 *
 * Why review text is never refused (the shop owner's decision, 2026-09-23):
 * the shop sells 情趣用品, and `msgSecCheck` reads an honest review of one as
 * risky often enough that refusing would silence real customers. A doubtful
 * review is held for a person instead — 待审核, which 评价管理 already lists
 * and publishes — and the shopper is told, neutrally, that it shows after
 * review. The same reasoning makes "WeChat did not answer" a hold rather than
 * a pass: nothing unreviewed goes live because a call failed.
 *
 * Nicknames and invoice titles fail **open**. An invoice title reaches only
 * the merchant and the tax office. A nickname *is* shown to other shoppers —
 * on a group-buy team, its activity page and its poster — but only masked to
 * its first character (`小*`, RISK-D-010), and a review freezes no nickname.
 * WeChat's own `type="nickname"` input has already screened a nickname typed
 * in the mini program, and refusing a profile save or an invoice because
 * WeChat is down punishes the customer for our dependency (the owner kept
 * fail-open on 2026-09-24). `risky` is still refused — that is the rule the
 * platform enforces.
 *
 * Pictures are public the moment they are saved, so their check is after the
 * fact by nature (WeChat answers by push, up to 30 minutes later). Unavailable
 * means "not checked yet": the effect retries, and the picture stays until a
 * verdict says otherwise.
 *
 * ## Who is checked
 *
 * WeChat checks content *for an openid* of the mini program — one that visited
 * in the last two hours. So only an account with a mini-program identity can
 * be checked. Everything is `skipped` (logged, never an error) while the
 * `content-security` switch is off or the mini program has no AppID/AppSecret.
 * With both on, an account with no mini-program identity (an H5 account, or a
 * session opened by SMS or password from an HTTP client) is `unchecked`, not
 * `skipped`: a caller that fails safe treats it like `unavailable`, so review
 * text from such an account waits in 待审核 (CONTENT-006) instead of going live
 * unread. Text is never logged, only the verdict.
 *
 * ## Pictures, end to end
 *
 * `requestMediaCheck` runs inside the business transaction: one
 * `content_security_checks` row and one `wechat.mediaCheck` effect. After
 * commit the effect calls `media_check_async` and stores WeChat's `trace_id`.
 * The `wxa_media_check` push (recorded by `wechat.mini-push.ts`) finds the row
 * by `trace_id`, stores the verdict with a conditional update — so a repeated
 * push acts once — and, on `risky`, calls the handler the owning domain
 * registered for that subject (`catalog` hides the picture, `user` resets the
 * avatar), in the same transaction.
 */

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

/** WeChat's `scene`: 1 资料, 2 评论, 3 论坛, 4 社交日志. */
export type SecCheckScene = 1 | 2 | 3 | 4;
export type SecCheckSuggest = 'pass' | 'review' | 'risky';

export interface MsgSecCheckAnswer {
  ok: boolean;
  errcode: number;
  errmsg: string;
  suggest: SecCheckSuggest | null;
  label: number | null;
}

export interface MediaCheckAnswer {
  ok: boolean;
  errcode: number;
  errmsg: string;
  traceId: string | null;
}

export interface ContentSecurityPort {
  msgSecCheck(input: {
    content: string;
    openid: string;
    scene: SecCheckScene;
  }): Promise<MsgSecCheckAnswer>;
  mediaCheckAsync(input: {
    mediaUrl: string;
    openid: string;
    scene: SecCheckScene;
  }): Promise<MediaCheckAnswer>;
}

let override: ((ctx: Ctx) => ContentSecurityPort) | undefined;

/** Replaces the driver — for a unit test only; the integration tests use the fake server. */
export function registerContentSecurityPort(factory: (ctx: Ctx) => ContentSecurityPort): void {
  override = factory;
}

/** Test helper. Never call this from app code. */
export function resetContentSecurityPort(): void {
  override = undefined;
}

export function contentSecurityPort(ctx: Ctx): ContentSecurityPort {
  return override ? override(ctx) : wechatContentSecurityDriver(ctx);
}

const SUGGESTS: ReadonlySet<string> = new Set(['pass', 'review', 'risky']);

function suggestOf(value: unknown): SecCheckSuggest | null {
  return typeof value === 'string' && SUGGESTS.has(value) ? (value as SecCheckSuggest) : null;
}

export function wechatContentSecurityDriver(ctx: Ctx): ContentSecurityPort {
  const client = getWechatClient(ctx);
  return {
    async msgSecCheck(input) {
      const raw = (await client.call<unknown>('mini', {
        method: 'POST',
        path: '/wxa/msg_sec_check',
        body: { content: input.content, version: 2, scene: input.scene, openid: input.openid },
      })) as {
        errcode?: number;
        errmsg?: string;
        result?: { suggest?: string; label?: number };
      } | null;
      const errcode = raw?.errcode ?? 0;
      const suggest = suggestOf(raw?.result?.suggest);
      return {
        ok: errcode === 0 && suggest !== null,
        errcode,
        errmsg: raw?.errmsg ?? 'ok',
        suggest,
        label: typeof raw?.result?.label === 'number' ? raw.result.label : null,
      };
    },

    async mediaCheckAsync(input) {
      const raw = (await client.call<unknown>('mini', {
        method: 'POST',
        path: '/wxa/media_check_async',
        body: {
          media_url: input.mediaUrl,
          media_type: 2,
          version: 2,
          scene: input.scene,
          openid: input.openid,
        },
      })) as { errcode?: number; errmsg?: string; trace_id?: string } | null;
      const errcode = raw?.errcode ?? 0;
      const traceId =
        typeof raw?.trace_id === 'string' && raw.trace_id !== '' ? raw.trace_id : null;
      return {
        ok: errcode === 0 && traceId !== null,
        errcode,
        errmsg: raw?.errmsg ?? 'ok',
        traceId,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// who is checked
// ---------------------------------------------------------------------------

/**
 * The mini-program openid to check under, or why there is none: `skipped` when
 * the shop has the check off (or no mini program to check with), `unchecked`
 * when the check is on but this account cannot be checked (CONTENT-006).
 */
async function checkIdentity(
  ctx: Ctx,
  userId: number | null,
): Promise<{ openid: string } | { skipped: string } | { unchecked: string }> {
  const { enabled } = await ctx.config.get(contentSecurityConfig);
  if (!enabled) return { skipped: 'disabled' };
  const wechat = await ctx.config.get(wechatConfig);
  if (wechat.miniAppId.trim() === '' || wechat.miniAppSecret.trim() === '') {
    return { skipped: 'mini-not-configured' };
  }
  if (userId === null) return { unchecked: 'no-user' };
  const openid = await findOpenid(ctx.db, userId, 'mini');
  return openid ? { openid } : { unchecked: 'no-mini-openid' };
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/**
 * `pass` / `review` / `risky` — WeChat's answer; `unavailable` — it gave none
 * (transport failure or an `errcode`); `unchecked` — the check is on but this
 * account has no mini-program identity to check under; `skipped` — the check
 * is off (see "Who is checked"). What each means is the caller's policy, per
 * the table above: a fail-safe caller holds on `unchecked` as on `unavailable`.
 */
export type TextVerdict = SecCheckSuggest | 'unavailable' | 'unchecked' | 'skipped';

/**
 * Checks one piece of text **outside** any transaction (it is an HTTP call),
 * before the write it decides about.
 */
export async function checkText(
  ctx: Ctx,
  input: { userId: number | null; content: string; scene: SecCheckScene; what: string },
): Promise<TextVerdict> {
  if (input.content.trim() === '') return 'pass';
  const identity = await checkIdentity(ctx, input.userId);
  if ('skipped' in identity) {
    ctx.logger.info({ what: input.what, reason: identity.skipped }, 'sec check skipped');
    return 'skipped';
  }
  if ('unchecked' in identity) {
    ctx.logger.info({ what: input.what, reason: identity.unchecked }, 'sec check impossible');
    return 'unchecked';
  }
  try {
    const answer = await contentSecurityPort(ctx).msgSecCheck({
      content: input.content,
      openid: identity.openid,
      scene: input.scene,
    });
    if (!answer.ok || answer.suggest === null) {
      ctx.logger.warn(
        { what: input.what, errcode: answer.errcode, errmsg: answer.errmsg },
        'msgSecCheck gave no verdict',
      );
      return 'unavailable';
    }
    if (answer.suggest !== 'pass') {
      ctx.logger.info(
        { what: input.what, suggest: answer.suggest, label: answer.label },
        'msgSecCheck flagged text',
      );
    }
    return answer.suggest;
  } catch (error) {
    ctx.logger.warn({ err: error, what: input.what }, 'msgSecCheck unreachable');
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// pictures
// ---------------------------------------------------------------------------

export type MediaSubject = ContentSecurityCheck['subject'];

export const MEDIA_CHECK_SCOPE = 'content-security';
export const MEDIA_CHECK_EVENT = 'wechat.mediaCheck';

/**
 * What the owning domain does with a `risky` picture, inside the transaction
 * that stores the verdict. Returns what it did, for the record
 * (`image_hidden`, `avatar_reset`, or `none` when the picture was already gone).
 */
export type MediaRiskHandler = (
  tx: Tx,
  ctx: Ctx,
  input: { checkId: number; subjectId: number; mediaUrl: string; userId: number | null },
) => Promise<string>;

const riskHandlers = new Map<MediaSubject, MediaRiskHandler>();

export function registerMediaRiskHandler(subject: MediaSubject, handler: MediaRiskHandler): void {
  riskHandlers.set(subject, handler);
}

/**
 * What the owning domain does with a picture that **cannot** be checked while
 * the check is on (CONTENT-006), inside the transaction that marks the check
 * `skipped`. Same shape as `MediaRiskHandler`; returns what it did
 * (`review_held`, or `none`).
 */
export type MediaUncheckedHandler = MediaRiskHandler;

const uncheckedHandlers = new Map<MediaSubject, MediaUncheckedHandler>();

export function registerMediaUncheckedHandler(
  subject: MediaSubject,
  handler: MediaUncheckedHandler,
): void {
  uncheckedHandlers.set(subject, handler);
}

/**
 * Queues one picture for `mediaCheckAsync`, inside the caller's transaction.
 * A no-op while 内容安全 is off; everything else (no openid, no public
 * address) is decided after commit and recorded as `skipped`.
 */
export async function requestMediaCheck(
  tx: Tx,
  ctx: Ctx,
  input: {
    subject: MediaSubject;
    subjectId: number;
    userId: number | null;
    mediaUrl: string;
    scene: SecCheckScene;
  },
): Promise<void> {
  const { enabled } = await ctx.config.getIn(tx, contentSecurityConfig);
  if (!enabled || input.mediaUrl.trim() === '') return;
  const checkId = await checks.insertMediaCheck(tx, {
    subject: input.subject,
    subjectId: input.subjectId,
    userId: input.userId,
    mediaUrl: input.mediaUrl,
    scene: input.scene,
  });
  await recordEffect(tx, ctx, {
    scope: MEDIA_CHECK_SCOPE,
    scopeId: String(checkId),
    eventType: MEDIA_CHECK_EVENT,
    payload: { checkId },
  });
}

/** `media_check_async` requires an address WeChat can fetch: absolute and HTTPS. */
async function publicMediaUrl(ctx: Ctx, url: string): Promise<string | null> {
  const trimmed = url.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('/')) {
    const origin = await publicOrigin(ctx);
    return origin.startsWith('https://') ? `${origin}${trimmed}` : null;
  }
  return null;
}

/** WeChat's "this user has not opened the mini program in two hours" — no retry fixes it. */
const USER_NOT_RECENT = 61010;

const markSkipped = checks.markMediaCheckSkipped;

/**
 * The check is on, but this picture will never be checked: mark it `skipped`
 * and let the owning domain act on that in the same transaction (CONTENT-006 —
 * a review goes back to 待审核). The conditional `pending → skipped` makes a
 * redelivered effect act once.
 */
async function skipUnchecked(ctx: Ctx, row: ContentSecurityCheck, now: Date): Promise<void> {
  await ctx.withTx(async (tx) => {
    const { won } = await markSkipped(tx, row.id, now);
    if (!won) return;
    const handler = uncheckedHandlers.get(row.subject);
    if (!handler) return;
    const action = await handler(tx, ctx, {
      checkId: row.id,
      subjectId: row.subjectId,
      mediaUrl: row.mediaUrl,
      userId: row.userId,
    });
    await checks.setMediaCheckAction(tx, { id: row.id, action, now });
  });
}

async function submitMediaCheck(ctx: Ctx, effect: Effect): Promise<void> {
  const checkId = Number((effect.payload as { checkId?: number } | null)?.checkId);
  const row = await checks.findMediaCheck(ctx.db, checkId);
  if (!row || row.status !== 'pending') return;
  const now = ctx.clock.now();

  const identity = await checkIdentity(ctx, row.userId);
  if ('skipped' in identity) {
    ctx.logger.info({ checkId, reason: identity.skipped }, 'media check skipped');
    await markSkipped(ctx.db, checkId, now);
    return;
  }
  if ('unchecked' in identity) {
    ctx.logger.info({ checkId, reason: identity.unchecked }, 'media check impossible');
    await skipUnchecked(ctx, row, now);
    return;
  }
  const mediaUrl = await publicMediaUrl(ctx, row.mediaUrl);
  if (mediaUrl === null) {
    ctx.logger.warn({ checkId }, 'media check skipped: no public https address for the picture');
    await skipUnchecked(ctx, row, now);
    return;
  }

  const answer = await contentSecurityPort(ctx).mediaCheckAsync({
    mediaUrl,
    openid: identity.openid,
    scene: row.scene as SecCheckScene,
  });
  if (answer.ok && answer.traceId !== null) {
    await checks.markMediaCheckSubmitted(ctx.db, { id: checkId, traceId: answer.traceId, now });
    return;
  }
  if (answer.errcode === USER_NOT_RECENT) {
    ctx.logger.info(
      { checkId },
      'media check skipped: the user has not opened the mini program lately',
    );
    await skipUnchecked(ctx, row, now);
    return;
  }
  // Anything else is WeChat saying "not now": the ledger retries.
  throw new SummarizedError(
    `mediaCheckAsync refused: ${answer.errcode} ${answer.errmsg}`.slice(0, 300),
    `微信暂不受理内容安全检测（错误码 ${answer.errcode}），${UNEXPLAINED}`,
  );
}

/**
 * `wxa_media_check`: the verdict on one picture. The conditional update on
 * `status = 'submitted'` is the idempotency — a repeated push, or a push
 * racing its own retry, finds the row already decided and does nothing.
 */
async function onMediaVerdict(ctx: Ctx, effect: Effect): Promise<void> {
  const message = (effect.payload ?? {}) as Record<string, unknown>;
  const traceId = typeof message['trace_id'] === 'string' ? message['trace_id'] : '';
  if (traceId === '') return;
  const result = (message['result'] ?? {}) as { suggest?: unknown; label?: unknown };
  const suggest = suggestOf(result.suggest);
  const label = typeof result.label === 'number' ? result.label : null;
  const now = ctx.clock.now();

  await ctx.withTx(async (tx) => {
    const row = await checks.findMediaCheckByTrace(tx, traceId);
    if (!row) {
      ctx.logger.warn({ traceId }, 'wxa_media_check for a trace id we never sent; ignored');
      return;
    }
    if (Number(message['errcode'] ?? 0) !== 0 || suggest === null) {
      ctx.logger.warn(
        { checkId: row.id, errcode: message['errcode'] },
        'wxa_media_check without a verdict; the picture stays',
      );
      return;
    }
    const decided = await checks.decideMediaCheck(tx, { id: row.id, verdict: suggest, label, now });
    if (!decided.won || suggest !== 'risky') return;

    const handler = riskHandlers.get(row.subject);
    const action = handler
      ? await handler(tx, ctx, {
          checkId: row.id,
          subjectId: row.subjectId,
          mediaUrl: row.mediaUrl,
          userId: row.userId,
        })
      : 'none';
    await checks.setMediaCheckAction(tx, { id: row.id, action, now });
    ctx.logger.warn(
      { checkId: row.id, subject: row.subject, subjectId: row.subjectId, label, action },
      'a picture failed WeChat’s content check',
    );
  });
}

export function registerContentSecurityEffects(): void {
  registerEffectHandler(MEDIA_CHECK_SCOPE, MEDIA_CHECK_EVENT, submitMediaCheck);
  registerEffectHandler(MINI_PUSH_SCOPE, 'wxa_media_check', onMediaVerdict);
}

/** For a test or a console: the checks recorded for one subject, oldest first. */
export function listMediaChecks(
  db: DbOrTx,
  subject: MediaSubject,
  subjectId: number,
): Promise<ContentSecurityCheck[]> {
  return checks.listMediaChecks(db, subject, subjectId);
}
