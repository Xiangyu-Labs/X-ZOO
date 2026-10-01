import type { DocumentIssue, Reference, ReferenceKind } from '@shop/contracts/decor/document';

import * as catalog from '../catalog';
import { articles, categories } from '../cms';
import * as coupon from '../coupon';
import * as groupbuy from '../groupbuy';
import type { Ctx } from '../kernel/context';
import * as presale from '../presale';
import * as repo from './decor.repo';

/**
 * Do the records a document points at exist, and can a shopper see them?
 * (DECOR-004.)
 *
 * **Decision: an unknown or unavailable id is a warning, never an error.** The
 * draft saves and the document publishes; the editor shows the warning; the
 * storefront resolver skips what it cannot show. Refusing would buy little —
 * availability changes after publishing anyway (a product goes off the shelf,
 * a coupon runs out, a campaign ends), and the resolver must handle that
 * regardless — and it would block an operator from publishing a page because
 * of one stale pick, or from preparing a page for a campaign that starts
 * tomorrow.
 *
 * Each record kind is asked of its own domain, through its `index.ts`, with
 * the anonymous shopper's eyes: "exists" means "a shopper would see it now".
 * A lookup that fails is logged and skipped: a check that cannot run never
 * blocks a save.
 */

type Checker = (ctx: Ctx, ids: string[]) => Promise<Set<string>>;

const CHECKERS: Record<ReferenceKind, { label: string; unavailable: string; visible: Checker }> = {
  product: {
    label: '商品',
    unavailable: '已下架或不存在',
    visible: async (ctx, ids) =>
      new Set((await catalog.productCardsFor(ctx, ids.map(Number))).map((card) => card.id)),
  },
  productCategory: {
    label: '商品分类',
    unavailable: '已隐藏或不存在',
    visible: async (ctx) => {
      const { items } = await catalog.categoryTree(ctx);
      const found = new Set<string>();
      for (const top of items) {
        found.add(top.id);
        for (const child of top.children) {
          found.add(child.id);
          for (const leaf of child.children) found.add(leaf.id);
        }
      }
      return found;
    },
  },
  productLabel: {
    label: '商品标签',
    unavailable: '下暂无在售商品',
    visible: async (ctx, ids) => {
      const found = new Set<string>();
      for (const labelId of ids) {
        const { total } = await catalog.productList(ctx, { page: 1, pageSize: 1, labelId });
        if (total > 0) found.add(labelId);
      }
      return found;
    },
  },
  article: {
    label: '资讯',
    unavailable: '未发布或不存在',
    visible: async (ctx, ids) =>
      new Set(
        (await articles.publicList(ctx, { page: 1, pageSize: ids.length, ids })).items.map(
          (item) => item.id,
        ),
      ),
  },
  articleCategory: {
    label: '资讯分类',
    unavailable: '已隐藏或不存在',
    visible: async (ctx) => {
      const { items } = await categories.publicList(ctx);
      return new Set(items.flatMap((top) => [top.id, ...top.children.map((child) => child.id)]));
    },
  },
  coupon: {
    label: '优惠券',
    unavailable: '当前不可领取或不存在',
    visible: async (ctx, ids) =>
      new Set(
        (await coupon.listClaimable(ctx, { page: 1, pageSize: ids.length, ids })).items.map(
          (item) => item.templateId,
        ),
      ),
  },
  groupbuy: {
    label: '拼团活动',
    unavailable: '未在进行中或不存在',
    visible: async (ctx, ids) =>
      new Set((await groupbuy.cardsFor(ctx, ids)).map((item) => item.activityId)),
  },
  presale: {
    label: '预售活动',
    unavailable: '未在进行中或不存在',
    visible: async (ctx, ids) =>
      new Set((await presale.cardsFor(ctx, ids)).map((item) => item.activityId)),
  },
  page: {
    label: '微页面',
    unavailable: '不存在或尚未发布',
    visible: async (ctx, ids) =>
      new Set(
        (await repo.findDocumentStates(ctx.db, ids.map(Number)))
          .filter((state) => state.publishedRevisionId !== null)
          .map((state) => String(state.id)),
      ),
  },
};

/** One warning per reference a shopper could not see now. `ctx` should be anonymous. */
export async function referenceWarnings(
  ctx: Ctx,
  references: readonly Reference[],
): Promise<DocumentIssue[]> {
  const byKind = new Map<ReferenceKind, Reference[]>();
  for (const reference of references) {
    byKind.set(reference.kind, [...(byKind.get(reference.kind) ?? []), reference]);
  }
  const warnings: DocumentIssue[] = [];
  await Promise.all(
    [...byKind].map(async ([kind, refs]) => {
      const checker = CHECKERS[kind];
      const ids = [...new Set(refs.map((ref) => ref.id))];
      let visible: Set<string>;
      try {
        visible = await checker.visible(ctx, ids);
      } catch (error) {
        ctx.logger.warn({ err: error, kind }, 'decor: reference check failed');
        return;
      }
      for (const ref of refs) {
        if (!visible.has(ref.id)) {
          warnings.push({
            path: ref.path,
            message: `${checker.label} ${ref.id} ${checker.unavailable}，商城中不会显示`,
          });
        }
      }
    }),
  );
  return warnings.sort((a, b) => a.path.localeCompare(b.path));
}
