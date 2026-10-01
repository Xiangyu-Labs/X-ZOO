import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { usePullToRefresh, useScrolledToBottom } from '@/platform';
import { ErrorBlock } from './error-block';
import { Pressable } from './pressable';
import './infinite-list.scss';

/**
 * What the list needs of a `useInfiniteRouteQuery` result (structurally, so a test or the
 * gallery can hand it a plain object).
 */
export interface PagedListState<T> {
  data: { pages: ReadonlyArray<{ items: readonly T[] }> } | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasNextPage: boolean;
  /** Any fetch: the next page, or every loaded page again (下拉刷新, back on the page). */
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
}

export interface InfiniteListProps<T> {
  query: PagedListState<T>;
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T) => string;
  /** 2 for the product grid (a masonry-free two-column grid; cards carry their own height). */
  columns?: 1 | 2 | undefined;
  /** An `<Empty>` for a list with nothing in it. */
  empty: ReactNode;
  /** What shows before the first page (a few `ProductCardSkeleton`s). */
  skeleton?: ReactNode;
  /** Only the list on screen listens for the page's pull-down and reach-bottom (tabbed pages). */
  active?: boolean | undefined;
  /** 下拉刷新; the page config must set `enablePullDownRefresh: true`. */
  refreshable?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A paged list (design.md §4.4): skeleton, then items; the next page loads as the page nears
 * its bottom; the footer says 加载中… / 没有更多了 / 加载失败，点击重试. A first-page failure
 * is a full `ErrorBlock`.
 */
export function InfiniteList<T>({
  query,
  renderItem,
  itemKey,
  columns = 1,
  empty,
  skeleton,
  active = true,
  refreshable = true,
  className,
}: InfiniteListProps<T>) {
  // Offset pages can overlap when rows move between two page loads (a new order on top, a
  // page 1 fetched again on return): a row already shown is not shown twice.
  const items: T[] = [];
  const seen = new Set<string>();
  for (const page of query.data?.pages ?? []) {
    for (const item of page.items) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  // Not while the list is read again: the next page would cancel that refetch (TanStack's
  // `cancelRefetch`), and the list would keep its old rows after 下拉刷新.
  const loadMore = () => {
    if (query.hasNextPage && !query.isFetching && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  };
  useScrolledToBottom(() => {
    if (active) loadMore();
  });
  usePullToRefresh(() => (active && refreshable ? query.refetch() : Promise.resolve()));

  if (query.isPending) {
    return (
      <View className={cx('shop-list', `shop-list--cols-${columns}`, className)}>{skeleton}</View>
    );
  }
  if (query.isError && items.length === 0) {
    return <ErrorBlock error={query.error} onRetry={() => query.refetch()} />;
  }
  if (items.length === 0) return <>{empty}</>;

  return (
    <View className={cx('shop-list', className)}>
      <View className={cx('shop-list__items', `shop-list--cols-${columns}`)}>
        {items.map((item, index) => (
          <View key={itemKey(item)} className="shop-list__item">
            {renderItem(item, index)}
          </View>
        ))}
      </View>
      <View className="shop-list__footer" ariaLive="polite">
        {query.isFetchingNextPage ? (
          <>
            <View className="shop-spinner shop-list__spinner" />
            <Text>加载中…</Text>
          </>
        ) : query.isFetchNextPageError ? (
          <Pressable
            label="加载失败，点击重试"
            className="shop-list__retry"
            onClick={() => query.fetchNextPage()}
          >
            加载失败，点击重试
          </Pressable>
        ) : query.hasNextPage ? (
          <Pressable label="加载更多" className="shop-list__more" onClick={loadMore}>
            上拉加载更多
          </Pressable>
        ) : (
          <Text className="shop-list__end">没有更多了</Text>
        )}
      </View>
    </View>
  );
}
