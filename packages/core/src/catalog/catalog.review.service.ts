import type { PageQuery } from '@shop/contracts/conventions';
import type {
  AdminProductReview,
  AdminReviewForm,
  AdminReviewListQuery,
  ProductReview,
  ProductReviewStatus,
  ReviewSubmitBody,
  ReviewSummary,
  SubmittedReview,
} from '@shop/contracts/catalog/schemas';
import type { Tx } from '@shop/db';

import { DomainError } from '../kernel/errors';
import { requireAdminId, requireUserId, type Ctx } from '../kernel/context';
import { catalogConfig } from './catalog.config';
import * as repo from './catalog.repo';
import { summariseReviews } from './catalog.rules';
import { asArray, pageBounds } from './catalog.service';
import { getOrderFacts } from '../order/ports';
import { isStoredImageUrl } from '../storage';
import type { AccountCancelledListener } from '../user';
import {
  checkText,
  requestMediaCheck,
  type MediaRiskHandler,
  type MediaUncheckedHandler,
  type TextVerdict,
} from '../wechat';

/**
 * Reviews, on both surfaces.
 *
 * Three things here are deliberate:
 *
 *  - **One review per purchased line, enforced by the database.**
 *    `product_reviews_order_item_uq` plus `ON CONFLICT DO NOTHING` — the
 *    service never asks "has this been reviewed?" and then inserts, because
 *    two taps on a slow phone both get past that question. The insert returns
 *    `null` for the loser and that becomes a 409.
 *  - **Eligibility comes from the order domain, not from a join.** The catalog
 *    has no business reading `orders`; `OrderFactsPort` answers "may this user
 *    review this line" and returns `null` for every kind of refusal, so a
 *    stranger probing order ids learns nothing.
 *  - **Moderation is a conditional update.** Approving a review guards on the
 *    status it moves from, and the batch version reports the rows it actually
 *    moved rather than the ids it was handed.
 */

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export async function adminReviewList(
  ctx: Ctx,
  query: AdminReviewListQuery,
): Promise<{ items: AdminProductReview[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listReviews(ctx.db, {
    keyword: query.keyword,
    productId: query.productId === undefined ? undefined : Number(query.productId),
    status: asArray(query.status),
    rating: query.rating,
    hasReply: query.hasReply,
    hasImages: query.hasImages,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return {
    items: await decorateAdminReviews(ctx, rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 虚拟评论: a review an operator writes for a product nobody bought.
 *
 * `orderItemId` stays null, which is precisely why the uniqueness index is
 * partial on it — an unlimited number of seeded reviews is allowed, exactly
 * one real one per purchased line. Backdating is permitted because a new shop
 * whose reviews are all dated today fools nobody.
 */
export async function adminReviewCreate(
  ctx: Ctx,
  body: AdminReviewForm,
): Promise<AdminProductReview> {
  requireAdminId(ctx);
  const productId = Number(body.productId);

  return ctx.withTx(async (tx) => {
    const product = await repo.findProduct(tx, productId);
    if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    let specText: string | null = null;
    if (body.skuId !== undefined) {
      const sku = await repo.findSku(tx, Number(body.skuId));
      if (!sku || sku.productId !== productId) throw new DomainError('CATALOG_SKU_NOT_FOUND');
      specText = sku.specText;
    }

    const now = ctx.clock.now();
    const createdAt = body.createdAt === undefined ? now : new Date(body.createdAt);
    const row = await repo.insertReview(tx, {
      productId,
      skuId: body.skuId === undefined ? null : Number(body.skuId),
      userId: null,
      orderId: null,
      orderItemId: null,
      authorNickname: body.authorNickname,
      authorAvatarUrl: body.authorAvatarUrl ?? null,
      specText,
      productScore: body.productScore,
      serviceScore: body.serviceScore,
      content: body.content ?? null,
      images: body.images,
      status: 'published',
      createdAt,
      updatedAt: now,
    });
    if (!row) throw new DomainError('CATALOG_REVIEW_ALREADY_WRITTEN');

    const [item] = await decorateAdminReviews(ctx, [row], tx);
    return item!;
  });
}

/**
 * Reply to a review, guarded on there being no reply yet.
 *
 * Two operators answering the same complaint at once must not both believe
 * they did; the loser gets `CATALOG_REVIEW_ALREADY_REPLIED` and refreshes to
 * see the other answer. Editing an existing reply is a separate route, so the
 * distinction survives into the audit log.
 */
export async function adminReviewReply(
  ctx: Ctx,
  input: { id: string },
  body: { content: string },
): Promise<AdminProductReview> {
  const id = Number(input.id);
  const adminId = requireAdminId(ctx);

  return ctx.withTx(async (tx) => {
    const existing = await repo.findReview(tx, id);
    if (!existing) throw new DomainError('CATALOG_REVIEW_NOT_FOUND');

    const { won } = await repo.replyToReview(tx, {
      id,
      content: body.content,
      adminId,
      now: ctx.clock.now(),
    });
    if (!won) throw new DomainError('CATALOG_REVIEW_ALREADY_REPLIED');

    return loadAdminReview(ctx, tx, id);
  });
}

export async function adminReviewReplyUpdate(
  ctx: Ctx,
  input: { id: string },
  body: { content: string },
): Promise<AdminProductReview> {
  const id = Number(input.id);
  const adminId = requireAdminId(ctx);

  return ctx.withTx(async (tx) => {
    const { won } = await repo.updateReviewReply(tx, {
      id,
      content: body.content,
      adminId,
      now: ctx.clock.now(),
    });
    if (!won) throw new DomainError('CATALOG_REVIEW_NOT_FOUND');
    return loadAdminReview(ctx, tx, id);
  });
}

export async function adminReviewSetStatus(
  ctx: Ctx,
  input: { id: string },
  body: { status: repo.ReviewStatusValue },
): Promise<AdminProductReview> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const row = await repo.findReview(tx, id);
    if (!row) throw new DomainError('CATALOG_REVIEW_NOT_FOUND');

    if (row.status !== body.status) {
      const { won } = await repo.setReviewStatus(tx, {
        id,
        from: [row.status],
        to: body.status,
        now: ctx.clock.now(),
      });
      if (!won) throw new DomainError('CATALOG_REVIEW_NOT_FOUND');
    }
    return loadAdminReview(ctx, tx, id);
  });
}

/**
 * 批量审核.
 *
 * One statement for the whole selection, with `status <> to` in the guard, so
 * `updated` means "rows this call moved". An operator who re-submits the same
 * selection sees 0, which is the truth and is what stops the audit log
 * claiming a hundred moderation decisions that did not happen.
 */
export async function adminReviewBatchSetStatus(
  ctx: Ctx,
  body: { reviewIds: string[]; status: repo.ReviewStatusValue },
): Promise<{ updated: number }> {
  return ctx.withTx(async (tx) => {
    const updated = await repo.setReviewStatuses(tx, {
      ids: body.reviewIds.map(Number),
      to: body.status,
      now: ctx.clock.now(),
    });
    return { updated };
  });
}

export async function adminReviewDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    const { won } = await repo.softDeleteReview(tx, { id, now: ctx.clock.now() });
    if (!won) throw new DomainError('CATALOG_REVIEW_NOT_FOUND');
  });
}

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

export async function productReviews(
  ctx: Ctx,
  input: { id: string },
  query: { rating: 'all' | 'good' | 'medium' | 'bad' | 'images' } & PageQuery,
): Promise<{ items: ProductReview[]; total: number; page: number; pageSize: number }> {
  const productId = Number(input.id);
  const { rows, total } = await repo.listReviews(ctx.db, {
    productId,
    status: ['published'],
    rating: query.rating === 'all' || query.rating === 'images' ? undefined : query.rating,
    hasImages: query.rating === 'images' ? true : undefined,
    ...pageBounds(query),
  });
  return {
    items: rows.map(toProductReview),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function productReviewSummary(
  ctx: Ctx,
  input: { id: string },
): Promise<ReviewSummary> {
  const productId = Number(input.id);
  const counts = await repo.reviewCountsFor(ctx.db, [productId]);
  return summariseReviews(
    counts.get(productId) ?? {
      productId,
      total: 0,
      good: 0,
      medium: 0,
      bad: 0,
      withImages: 0,
      scoreSum: 0,
    },
  );
}

/**
 * The shopper posts a review.
 *
 * Eligibility is the port's answer and nothing else. The insert is
 * `ON CONFLICT DO NOTHING` on `(order_item_id)`, so a double tap produces one
 * row and one 409 rather than two reviews or a 500 from a unique violation.
 *
 * `reviewRequiresAudit` decides whether it appears immediately or waits for
 * moderation. It is a setting rather than a fixed "visible at once", so a shop
 * can hold reviews back before the first abusive one goes live.
 *
 * 内容安全 (C09, CONTENT-001): the text goes to WeChat's `msgSecCheck` first,
 * outside the transaction. A `risky` or `review` verdict, no verdict at all, or
 * an author WeChat cannot check under (no mini-program openid, CONTENT-006)
 * **holds** the review in 待审核 with the reason — it is never refused, because
 * this shop's honest reviews trip the check too often (the owner's call,
 * 2026-09-23). The answer says `moderation: 'pending'` and nothing more; the
 * client shows 「评价已提交，审核后展示」. Each picture is queued for
 * `mediaCheckAsync` in the same transaction as the review; one that turns out
 * uncheckable sends the review back to 待审核 (`holdUncheckedReview`).
 *
 * Every picture must be one our own storage holds (CAT-018), exactly as the
 * avatar must (USER-019): a review is public, and a link to somebody else's
 * server could change what it shows after WeChat checked it, or log every
 * shopper who opens the product page. Checked before anything else, so a
 * refused picture costs no `msgSecCheck` call.
 */
export async function reviewSubmit(ctx: Ctx, body: ReviewSubmitBody): Promise<SubmittedReview> {
  const userId = requireUserId(ctx);
  for (const url of new Set(body.images)) {
    if (!(await isStoredImageUrl(ctx, url))) {
      throw new DomainError('CATALOG_REVIEW_IMAGE_NOT_ALLOWED');
    }
  }
  const config = await ctx.config.get(catalogConfig);
  const verdict = await checkText(ctx, {
    userId,
    content: body.content ?? '',
    scene: 2,
    what: 'review',
  });
  const moderationReason = HELD_BY[verdict];
  const status = moderationReason !== null || config.reviewRequiresAudit ? 'pending' : 'published';

  return ctx.withTx(async (tx) => {
    const line = await getOrderFacts().findReviewableLine(tx, {
      orderItemId: Number(body.orderItemId),
      userId,
    });
    if (!line) throw new DomainError('CATALOG_REVIEW_NOT_ALLOWED');

    const now = ctx.clock.now();
    const row = await repo.insertReview(tx, {
      productId: line.productId,
      skuId: line.skuId,
      userId,
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      authorNickname: null,
      authorAvatarUrl: null,
      specText: line.specText,
      productScore: body.productScore,
      serviceScore: body.serviceScore,
      content: body.content ?? null,
      images: body.images,
      status,
      moderationReason,
      createdAt: now,
      updatedAt: now,
    });
    if (!row) throw new DomainError('CATALOG_REVIEW_ALREADY_WRITTEN');

    for (const url of new Set(body.images)) {
      await requestMediaCheck(tx, ctx, {
        subject: 'review_image',
        subjectId: row.id,
        userId,
        mediaUrl: url,
        scene: 2,
      });
    }

    return {
      ...toProductReview(row),
      moderation: status === 'published' ? 'published' : 'pending',
    };
  });
}

/**
 * Which text verdicts hold a review for a person, and the reason recorded.
 * `unchecked` — the check is on but the author has no mini-program openid (an
 * H5 account, or a session opened by SMS or password from any HTTP client) —
 * holds like `unavailable` (CONTENT-006): otherwise anybody could post
 * unscreened text by simply not signing in through the mini program.
 */
const HELD_BY: Record<TextVerdict, string | null> = {
  pass: null,
  skipped: null,
  review: 'sec_check_review',
  risky: 'sec_check_risky',
  unavailable: 'sec_check_unavailable',
  unchecked: 'sec_check_unchecked',
};

/** The reason a review goes back to 待审核 when one of its pictures cannot be checked. */
export const IMAGE_UNCHECKED_REASON = 'sec_check_image_unchecked';

/**
 * `wxa_media_check` said a review picture is `risky`: it comes off the review
 * (its address stays on the `content_security_checks` row). The review itself
 * stays as it was — one bad picture is not a bad review.
 */
export const hideRiskyReviewImage: MediaRiskHandler = async (tx, ctx, input) =>
  (await repo.removeReviewImage(tx, {
    id: input.subjectId,
    url: input.mediaUrl,
    now: ctx.clock.now(),
  }))
    ? 'image_hidden'
    : 'none';

/**
 * A review picture WeChat will never check although 内容安全 is on (no
 * mini-program openid, 61010 "not opened lately", no public https address):
 * the review goes to 待审核 with `sec_check_image_unchecked` (CONTENT-006), so
 * nothing unscreened stays public. A review that already carries a moderation
 * reason — held for its text, or held and then approved by an admin — is left
 * as it is: a person has already looked, or will.
 */
export const holdUncheckedReview: MediaUncheckedHandler = async (tx, ctx, input) =>
  (await repo.holdReview(tx, {
    id: input.subjectId,
    reason: IMAGE_UNCHECKED_REASON,
    now: ctx.clock.now(),
  }))
    ? 'review_held'
    : 'none';

/**
 * 注销 (`onAccountCancelled`): the shopper's reviews stay — the score is part
 * of the product's, and the words were written for other buyers — but the
 * storefront draws them as 匿名用户 with the default avatar.
 *
 * Reviews this app writes for a shopper carry no copy of the profile (the
 * `null`s in `reviewSubmit` and `runAutoReview`); the columns exist for the
 * reviews an operator seeds, which have no user. A row with both a user and a
 * name came from somewhere else — an import — and is exactly what this clears.
 */
export const forgetReviewAuthor: AccountCancelledListener = async (tx, ctx, { userId }) => {
  await repo.clearReviewAuthorOf(tx, { userId, now: ctx.clock.now() });
};

export async function myReviews(
  ctx: Ctx,
  query: PageQuery,
): Promise<{
  items: (ProductReview & {
    productId: string;
    productName: string;
    productImageUrl: string;
    status: ProductReviewStatus;
  })[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const userId = requireUserId(ctx);
  const { rows, total } = await repo.listReviews(ctx.db, { userId, ...pageBounds(query) });
  const products = await repo.productsByIds(
    ctx.db,
    rows.map((r) => r.productId),
  );

  return {
    items: rows.map((row) => {
      const product = products.get(row.productId);
      return {
        ...toProductReview(row),
        productId: String(row.productId),
        productName: product?.name ?? '',
        productImageUrl: product?.imageUrl ?? '',
        status: row.status,
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// the auto-review sweep
// ---------------------------------------------------------------------------

export interface AutoReviewResult {
  scanned: number;
  written: number;
}

/**
 * 系统默认好评: after `autoReviewDays`, an unreviewed completed line gets a
 * five-star review with the configured text.
 *
 * Runs as one transaction per batch, and is safe to run twice: the uniqueness
 * index on `order_item_id` means a line already reviewed — by the shopper in
 * the meantime, or by an earlier run — is skipped by the database rather than
 * by a check the job has to get right. `written` counts rows that actually
 * landed.
 *
 * The shopper's own review always wins, because the port only returns lines
 * with no review at all.
 */
export async function runAutoReview(
  ctx: Ctx,
  options: { limit?: number } = {},
): Promise<AutoReviewResult> {
  const config = await ctx.config.get(catalogConfig);
  const limit = options.limit ?? 200;
  const now = ctx.clock.now();
  const completedBefore = new Date(now.getTime() - config.autoReviewDays * 24 * 60 * 60 * 1000);

  return ctx.withTx(async (tx) => {
    const lines = await getOrderFacts().findLinesAwaitingReview(tx, { completedBefore, limit });
    let written = 0;

    for (const line of lines) {
      const row = await repo.insertReview(tx, {
        productId: line.productId,
        skuId: line.skuId,
        userId: line.userId,
        orderId: line.orderId,
        orderItemId: line.orderItemId,
        authorNickname: null,
        authorAvatarUrl: null,
        specText: line.specText,
        productScore: 5,
        serviceScore: 5,
        content: config.autoReviewContent,
        images: [],
        status: 'published',
        createdAt: now,
        updatedAt: now,
      });
      if (row) written += 1;
    }

    return { scanned: lines.length, written };
  });
}

// ---------------------------------------------------------------------------
// row -> DTO
// ---------------------------------------------------------------------------

function toProductReview(row: repo.ReviewRow): ProductReview {
  return {
    id: String(row.id),
    skuId: row.skuId === null ? null : String(row.skuId),
    specText: row.specText,
    authorNickname: row.authorNickname,
    authorAvatarUrl: row.authorAvatarUrl,
    productScore: row.productScore,
    serviceScore: row.serviceScore,
    content: row.content,
    images: row.images,
    replyContent: row.replyContent,
    replyAt: row.replyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function decorateAdminReviews(
  ctx: Ctx,
  rows: readonly repo.ReviewRow[],
  tx?: Tx,
): Promise<AdminProductReview[]> {
  const db = tx ?? ctx.db;
  const products = await repo.productsByIds(
    db,
    rows.map((r) => r.productId),
  );
  return rows.map((row) => {
    const product = products.get(row.productId);
    return {
      ...toProductReview(row),
      productId: String(row.productId),
      productName: product?.name ?? '',
      productImageUrl: product?.imageUrl ?? '',
      userId: row.userId === null ? null : String(row.userId),
      orderId: row.orderId === null ? null : String(row.orderId),
      orderItemId: row.orderItemId === null ? null : String(row.orderItemId),
      status: row.status,
      moderationReason: row.moderationReason,
    };
  });
}

async function loadAdminReview(ctx: Ctx, tx: Tx, id: number): Promise<AdminProductReview> {
  const row = await repo.findReview(tx, id);
  if (!row) throw new DomainError('CATALOG_REVIEW_NOT_FOUND');
  const [item] = await decorateAdminReviews(ctx, [row], tx);
  return item!;
}
