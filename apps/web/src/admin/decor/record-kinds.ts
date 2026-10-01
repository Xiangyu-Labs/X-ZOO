import {
  cmsArticleDetail,
  cmsArticleList,
  cmsCategoryList,
} from '@shop/contracts/cms/cms.admin.contract';
import type { ArticleCategory } from '@shop/contracts/cms/schemas';
import { couponAdminDetail, couponAdminList } from '@shop/contracts/coupon/coupon.admin.contract';
import type { CouponTemplateListItem } from '@shop/contracts/coupon/schemas';
import {
  groupbuyAdminActivityDetail,
  groupbuyAdminActivityList,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import type { GroupbuyActivityListItem } from '@shop/contracts/groupbuy/schemas';

import { ApiError, callRoute } from '../api';
import { formatInstant, formatMoney } from '../kit';
import type { DecorRecord, DecorRecordPage, DecorRecordQuery, DecorTreeNode } from './record-types';

/**
 * 文章, 优惠券 and 拼团 for the editor's pickers, over the admin contracts of
 * the domain that owns each record. `createDecorRecordSource` in `records.tsx`
 * composes these with the catalog's (`catalog-records.ts`), 预售 and 微页面.
 *
 * | kind       | records              | offered                               |
 * | ---------- | -------------------- | ------------------------------------- |
 * | `article`  | CMS articles         | published                             |
 * | `coupon`   | coupon templates     | claimable now, as the 领券中心 lists   |
 * | `groupbuy` | group-buy activities | active and running now                |
 *
 * The ids are the ones the storefront sends back to the storefront API: an
 * article id, a coupon *template* id and a group-buy activity id.
 */

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/**
 * One detail call per id. A record deleted since the page was saved answers
 * 404 and drops out; any other failure is the caller's, so an outage never
 * reads as "nothing was picked".
 */
export async function resolveEach(
  ids: readonly string[],
  load: (id: string) => Promise<DecorRecord>,
): Promise<DecorRecord[]> {
  const rows = await Promise.all(
    ids.map(async (id) => {
      try {
        return [await load(id)];
      } catch (error) {
        if (ApiError.is(error) && error.status === 404) return [];
        throw error;
      }
    }),
  );
  return rows.flat();
}

const SCAN_PAGE_SIZE = 100;
/** 5 000 rows: far past any real shop's live coupons or group-buys. */
const SCAN_MAX_PAGES = 50;

/**
 * Pages through a whole admin list, keeps the rows `keep` accepts, and pages
 * the survivors itself.
 *
 * For the kinds whose "what the storefront shows" test depends on the clock
 * (a claim window, an activity's start and end), which the admin list routes
 * cannot filter on. Filtering one server page at a time would leave short
 * pages and a wrong total; these lists are small, so reading them whole is the
 * honest way to get both right.
 */
export async function pageFiltered<T>(
  fetchPage: (page: number, pageSize: number) => Promise<{ items: T[]; total: number }>,
  keep: (row: T) => boolean,
  query: DecorRecordQuery,
): Promise<{ items: T[]; total: number }> {
  const kept: T[] = [];
  for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
    const batch = await fetchPage(page, SCAN_PAGE_SIZE);
    kept.push(...batch.items.filter(keep));
    if (batch.items.length < SCAN_PAGE_SIZE || page * SCAN_PAGE_SIZE >= batch.total) break;
  }
  const start = (query.page - 1) * query.pageSize;
  return { items: kept.slice(start, start + query.pageSize), total: kept.length };
}

const before = (instant: string | null, now: Date): boolean =>
  instant === null || new Date(instant).getTime() <= now.getTime();
const after = (instant: string | null, now: Date): boolean =>
  instant === null || new Date(instant).getTime() >= now.getTime();

// ---------------------------------------------------------------------------
// 文章
// ---------------------------------------------------------------------------

function toArticleItem(row: {
  id: string;
  title: string;
  coverImageUrl: string | null;
  categoryTitle: string | null;
  publishedAt: string | null;
}): DecorRecord {
  const subtitle = row.categoryTitle ?? formatInstant(row.publishedAt, 'date', '');
  return {
    id: row.id,
    name: row.title,
    ...(row.coverImageUrl ? { image: row.coverImageUrl } : {}),
    ...(subtitle ? { subtitle } : {}),
  };
}

/** Published only: the storefront serves nothing else, so nothing else may be linked. */
export async function listArticles(query: DecorRecordQuery): Promise<DecorRecordPage> {
  const page = await callRoute(cmsArticleList, {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      status: 'published',
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    },
  });
  return { items: page.items.map(toArticleItem), total: page.total };
}

export function resolveArticles(ids: readonly string[]): Promise<DecorRecord[]> {
  return resolveEach(ids, async (id) =>
    toArticleItem(await callRoute(cmsArticleDetail, { params: { id } })),
  );
}

/**
 * Visible 文章分类, nested. The route answers the two-level tree flat and
 * depth-first, children after their parent.
 */
export async function articleCategoryTree(): Promise<DecorTreeNode[]> {
  const list = await callRoute(cmsCategoryList, { query: { status: 'visible' } });
  return nestArticleCategories(list.items);
}

export function nestArticleCategories(rows: readonly ArticleCategory[]): DecorTreeNode[] {
  const children = new Map<string, DecorTreeNode[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const siblings = children.get(row.parentId) ?? [];
    siblings.push({ id: row.id, name: row.title });
    children.set(row.parentId, siblings);
  }
  return rows
    .filter((row) => row.parentId === null)
    .map((row) => {
      const kids = children.get(row.id);
      return { id: row.id, name: row.title, ...(kids ? { children: kids } : {}) };
    });
}

// ---------------------------------------------------------------------------
// 优惠券
// ---------------------------------------------------------------------------

/**
 * The storefront's 领券中心 test, row by row: active, claimed by hand, inside
 * its claim window, not sold out, and not already past its fixed validity.
 * The server applies the first two; the clock-bound rest is applied here.
 */
export function isClaimableNow(row: CouponTemplateListItem, now: Date): boolean {
  return (
    row.status === 'active' &&
    row.claimMode === 'manual' &&
    before(row.claimFrom, now) &&
    after(row.claimTo, now) &&
    (row.isUnlimitedSupply || (row.remainingCount ?? 0) > 0) &&
    after(row.validTo, now)
  );
}

function couponSubtitle(row: { discountAmount: string; minSpend: string }): string {
  const off = formatMoney(row.discountAmount);
  return Number(row.minSpend) > 0
    ? `满 ${formatMoney(row.minSpend)} 减 ${off}`
    : `无门槛 减 ${off}`;
}

function toCouponItem(row: {
  id: string;
  name: string;
  discountAmount: string;
  minSpend: string;
}): DecorRecord {
  return { id: row.id, name: row.name, subtitle: couponSubtitle(row) };
}

export async function listCoupons(query: DecorRecordQuery, now: Date): Promise<DecorRecordPage> {
  const result = await pageFiltered(
    (page, pageSize) =>
      callRoute(couponAdminList, {
        query: {
          page,
          pageSize,
          status: 'active',
          claimMode: 'manual',
          ...(query.keyword ? { keyword: query.keyword } : {}),
        },
      }),
    (row) => isClaimableNow(row, now),
    query,
  );
  return { items: result.items.map(toCouponItem), total: result.total };
}

export function resolveCoupons(ids: readonly string[]): Promise<DecorRecord[]> {
  return resolveEach(ids, async (id) =>
    toCouponItem(await callRoute(couponAdminDetail, { params: { id } })),
  );
}

// ---------------------------------------------------------------------------
// 拼团
// ---------------------------------------------------------------------------

/** What the storefront's 拼团 list shows: active, started, and not yet ended. */
export function isRunningNow(row: GroupbuyActivityListItem, now: Date): boolean {
  return (
    row.status === 'active' &&
    new Date(row.startAt).getTime() <= now.getTime() &&
    new Date(row.endAt).getTime() > now.getTime()
  );
}

function toGroupbuyItem(row: {
  id: string;
  title: string;
  imageUrl: string | null;
  price: string;
  seatsRequired: number;
}): DecorRecord {
  return {
    id: row.id,
    name: row.title,
    ...(row.imageUrl ? { image: row.imageUrl } : {}),
    subtitle: `${formatMoney(row.price)} · ${row.seatsRequired} 人团`,
  };
}

export async function listGroupbuys(query: DecorRecordQuery, now: Date): Promise<DecorRecordPage> {
  const result = await pageFiltered(
    (page, pageSize) =>
      callRoute(groupbuyAdminActivityList, {
        query: {
          page,
          pageSize,
          status: 'active',
          ...(query.keyword ? { keyword: query.keyword } : {}),
        },
      }),
    (row) => isRunningNow(row, now),
    query,
  );
  return { items: result.items.map(toGroupbuyItem), total: result.total };
}

export function resolveGroupbuys(ids: readonly string[]): Promise<DecorRecord[]> {
  return resolveEach(ids, async (id) =>
    toGroupbuyItem(await callRoute(groupbuyAdminActivityDetail, { params: { id } })),
  );
}
