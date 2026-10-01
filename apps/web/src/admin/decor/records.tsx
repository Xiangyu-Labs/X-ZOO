'use client';

import { decorDocumentGet, decorDocumentList } from '@shop/contracts/decor/decor.admin.contract';
import {
  presaleAdminActivityDetail,
  presaleAdminActivityList,
} from '@shop/contracts/presale/presale.admin.contract';
import type { PresaleActivityListItem } from '@shop/contracts/presale/schemas';
import { createContext, useContext, type ReactNode } from 'react';

import { callRoute } from '../api';
import { formatMoney } from '../kit';
import {
  listLabels,
  listProducts,
  productCategoryTree,
  resolveLabels,
  resolveProducts,
} from './catalog-records';
import {
  articleCategoryTree,
  listArticles,
  listCoupons,
  listGroupbuys,
  pageFiltered,
  resolveArticles,
  resolveCoupons,
  resolveEach,
  resolveGroupbuys,
} from './record-kinds';
import type { DecorRecord, DecorRecordPage, DecorRecordQuery, DecorTreeNode } from './record-types';

export type { DecorRecord, DecorRecordPage, DecorRecordQuery, DecorTreeNode } from './record-types';

/**
 * The records a decorated page can point at, for the editor's pickers.
 *
 * | kind       | records                    | offered                                  |
 * | ---------- | -------------------------- | ---------------------------------------- |
 * | `product`  | catalog products           | on shelf                                 |
 * | `label`    | 商品标签                    | enabled                                  |
 * | `article`  | CMS articles               | published                                |
 * | `coupon`   | coupon templates           | claimable now, as the 领券中心 lists      |
 * | `groupbuy` | group-buy campaigns        | active and running now                   |
 * | `presale`  | presale campaigns          | active and not yet ended                 |
 * | `page`     | decor documents (微页面)    | every 微页面 (published or not: see below) |
 *
 * Each kind is answered from the owning domain's admin contracts:
 * `catalog-records.ts` (商品, 商品标签, 商品分类), `record-kinds.ts` (文章,
 * 优惠券, 拼团) and this file (预售, 微页面).
 *
 * A 微页面 link may point at a page that is not published yet: operators build
 * the landing page and the banner that links to it together. The server warns
 * about a link to an unpublished page when the linking page is saved
 * (DECOR-004); the storefront skips it until the page goes live.
 *
 * This is a port the pickers call inside a query, and there is no default: a picker outside `<DecorRecordSourceProvider>` throws,
 * so nothing outside the shop can be picked into a stored page.
 */

export type DecorRecordKind =
  'product' | 'label' | 'article' | 'coupon' | 'groupbuy' | 'presale' | 'page';

export const RECORD_KIND_LABELS: Record<DecorRecordKind, string> = {
  product: '商品',
  label: '商品标签',
  article: '资讯',
  coupon: '优惠券',
  groupbuy: '拼团活动',
  presale: '预售活动',
  page: '微页面',
};

export interface DecorRecordSource {
  list(kind: DecorRecordKind, query: DecorRecordQuery): Promise<DecorRecordPage>;
  /**
   * Stored ids back into rows, in the order given. An id whose record is gone
   * drops out; any other failure throws, so an outage never reads as "nothing
   * is picked" and lets the operator overwrite the stored ids.
   */
  resolve(kind: DecorRecordKind, ids: readonly string[]): Promise<DecorRecord[]>;
  categories(kind: 'product' | 'article'): Promise<DecorTreeNode[]>;
}

interface KindSource {
  list(query: DecorRecordQuery): Promise<DecorRecordPage>;
  resolve(ids: readonly string[]): Promise<DecorRecord[]>;
}

export interface DecorRecordSourceOptions {
  /** The clock the time-window filters read. Tests pin it. */
  now?: (() => Date) | undefined;
}

export function createDecorRecordSource(options: DecorRecordSourceOptions = {}): DecorRecordSource {
  const now = options.now ?? (() => new Date());
  // A `Record` over every kind, so a new kind does not compile until it has a
  // real list and resolve.
  const kinds: Record<DecorRecordKind, KindSource> = {
    product: { list: listProducts, resolve: resolveProducts },
    label: { list: listLabels, resolve: resolveLabels },
    article: { list: listArticles, resolve: resolveArticles },
    coupon: { list: (query) => listCoupons(query, now()), resolve: resolveCoupons },
    groupbuy: { list: (query) => listGroupbuys(query, now()), resolve: resolveGroupbuys },
    presale: { list: (query) => listPresales(query, now()), resolve: resolvePresales },
    page: { list: listPages, resolve: resolvePages },
  };
  return {
    list: (kind, query) => kinds[kind].list(query),
    resolve: (kind, ids) => (ids.length === 0 ? Promise.resolve([]) : kinds[kind].resolve(ids)),
    categories: (kind): Promise<DecorTreeNode[]> =>
      kind === 'product' ? productCategoryTree() : articleCategoryTree(),
  };
}

// ---------------------------------------------------------------------------

function toPresaleRecord(row: {
  id: string;
  title: string;
  imageUrl: string | null;
  price: string;
  status: string;
}): DecorRecord {
  return {
    id: row.id,
    name: row.title,
    ...(row.imageUrl ? { image: row.imageUrl } : {}),
    subtitle: `${formatMoney(row.price)}${row.status === 'active' ? '' : ' · 未进行'}`,
  };
}

/** What the storefront's 预售 list can show: active and not yet ended (upcoming included). */
export function isPresaleShowable(row: PresaleActivityListItem, now: Date): boolean {
  return row.status === 'active' && new Date(row.endAt).getTime() > now.getTime();
}

async function listPresales(query: DecorRecordQuery, now: Date): Promise<DecorRecordPage> {
  // The list cannot filter on the clock, so read it whole (it is small) and
  // page the survivors here — the same approach as the 拼团 picker.
  const result = await pageFiltered(
    (page, pageSize) =>
      callRoute(presaleAdminActivityList, {
        query: {
          page,
          pageSize,
          status: 'active',
          ...(query.keyword ? { keyword: query.keyword } : {}),
        },
      }),
    (row) => isPresaleShowable(row, now),
    query,
  );
  return { items: result.items.map(toPresaleRecord), total: result.total };
}

function resolvePresales(ids: readonly string[]): Promise<DecorRecord[]> {
  return resolveEach(ids, async (id) =>
    toPresaleRecord(await callRoute(presaleAdminActivityDetail, { params: { id } })),
  );
}

function toPageRecord(row: {
  id: string;
  name: string;
  title: string;
  published: unknown;
}): DecorRecord {
  return {
    id: row.id,
    name: row.name,
    subtitle: `${row.title}${row.published ? '' : ' · 未发布'}`,
  };
}

async function listPages(query: DecorRecordQuery): Promise<DecorRecordPage> {
  const page = await callRoute(decorDocumentList, {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      kind: 'custom',
      ...(query.keyword ? { keyword: query.keyword } : {}),
    },
  });
  return { items: page.items.map(toPageRecord), total: page.total };
}

function resolvePages(ids: readonly string[]): Promise<DecorRecord[]> {
  return resolveEach(ids, async (id) =>
    toPageRecord(await callRoute(decorDocumentGet, { params: { id } })),
  );
}

// ---------------------------------------------------------------------------

const DecorRecordSourceContext = createContext<DecorRecordSource | null>(null);

export function DecorRecordSourceProvider({
  source,
  children,
}: {
  source: DecorRecordSource;
  children: ReactNode;
}) {
  return <DecorRecordSourceContext value={source}>{children}</DecorRecordSourceContext>;
}

export function useDecorRecordSource(): DecorRecordSource {
  const source = useContext(DecorRecordSourceContext);
  if (!source) {
    throw new Error('useDecorRecordSource() needs a <DecorRecordSourceProvider> above it');
  }
  return source;
}
