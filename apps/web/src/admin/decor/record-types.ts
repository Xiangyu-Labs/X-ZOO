/**
 * The row shapes of the editor's record pickers, shared by `records.tsx` (the
 * port and its provider) and the per-domain kinds behind it
 * (`catalog-records.ts`, `record-kinds.ts`). A file of its own so those can
 * import the types without importing the React context.
 */

export interface DecorRecord {
  id: string;
  name: string;
  /** Thumbnail URL, when the record has one. */
  image?: string | undefined;
  /** Second line: price for a product, article date, coupon face value. */
  subtitle?: string | undefined;
}

export interface DecorRecordQuery {
  keyword?: string | undefined;
  /** Restricts to one category, where the record type has categories (商品, 文章). */
  categoryId?: string | undefined;
  page: number;
  pageSize: number;
}

export interface DecorRecordPage {
  items: DecorRecord[];
  total: number;
}

export interface DecorTreeNode {
  id: string;
  name: string;
  children?: DecorTreeNode[] | undefined;
}
