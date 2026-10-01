/** What kind of thing a storefront link points at. */
export type LinkTargetType = 'page' | 'product' | 'category' | 'article' | 'custom';

/** What `<LinkPicker>` returns and what DIY components / banners store. */
export interface LinkValue {
  type: LinkTargetType;
  /** Human label for the admin UI, e.g. 商品详情 · 秋季新款外套. */
  label: string;
  /** Storefront path (`/pages/goods_details/index?id=12`) or absolute URL. */
  url: string;
}

/** A built-in storefront page, e.g. 首页 / 购物车 / 我的订单. */
export interface LinkPage {
  id: string;
  name: string;
  url: string;
}

export interface LinkPageGroup {
  group: string;
  items: LinkPage[];
}

/** A searchable record: a product, a category, an article. */
export interface LinkTarget {
  id: string;
  name: string;
  url: string;
  thumb?: string | undefined;
  subtitle?: string | undefined;
}

export interface LinkTargetQuery {
  keyword?: string | undefined;
  page: number;
  pageSize: number;
}

export interface LinkTargetResult {
  items: LinkTarget[];
  total: number;
}

/**
 * Everything `<LinkPicker>` needs.
 *
 * The kit ships the UI only. Whatever renders a picker installs the source
 * with `<LinkSourceProvider source={…}>`.
 */
export interface LinkSource {
  listPages(): Promise<LinkPageGroup[]>;
  listTargets(
    type: Exclude<LinkTargetType, 'page' | 'custom'>,
    query: LinkTargetQuery,
  ): Promise<LinkTargetResult>;
}
