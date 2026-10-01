import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import { useQueryClient } from '@tanstack/react-query';
import {
  infiniteRouteQueryOptions,
  routeKey,
  routeQueryKey,
  useApiClient,
  useInfiniteRouteQuery,
  useRouteQuery,
} from '@shop/api-client/react';
import { useTabPage } from '@/app-shell/tab-page';
import { useAppConfig } from '@/app-config';
import { LIST_FULL_RELOAD_AFTER_MS, useRefetchOnShow } from '@/data/use-refetch-on-show';
import { useQuickAdd } from '@/features/cart/quick-add';
import {
  showsSubcategories,
  subtreeIds,
  topLevelOf,
  type TopCategory,
} from '@/features/catalog/category-tree';
import { recallFirstCategory, rememberFirstCategory } from '@/features/catalog/first-category';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { navigate, scrollPageToTop, useShare } from '@/platform';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { Image } from '@/ui/image';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { ProductCard } from '@/ui/product-card';
import { SearchBar } from '@/ui/search-bar';
import { ProductCardSkeleton, Skeleton } from '@/ui/skeleton';
import './index.scss';

/** What a level-1 category's product list asks for: its whole subtree. */
const productsOf = (categoryIds: string[]) => ({ query: { categoryIds, pageSize: 20 } });

/**
 * 分类 (tab `category { categoryId? }`, design.md §5 版式 F): level-1 categories on the left;
 * on the right the category's banner, its level-2 grid (each opens 商品列表) and the products
 * of the whole subtree, with 加购. `categoryId` (from a DIY link or a share) picks the level-1
 * category that holds it.
 */
export default function Category() {
  const params = useTabPage('category');
  const config = useAppConfig();
  const queryClient = useQueryClient();
  const api = useApiClient();
  // A cold open: start the first category's list, as the tree had it last time, while the
  // tree loads (the list needs the tree's subtree ids and would otherwise wait a round trip).
  const [guess] = useState(() =>
    queryClient.getQueryData(routeQueryKey('catalog.categoryTree'))
      ? null
      : guessedCategory(params.categoryId),
  );
  useEffect(() => {
    if (!guess) return;
    void queryClient.prefetchInfiniteQuery(
      infiniteRouteQueryOptions(api, 'catalog.productList', productsOf(guess)),
    );
  }, [guess, queryClient, api]);
  const tree = useRouteQuery('catalog.categoryTree', undefined, { staleTime: 5 * 60_000 });
  // A tab page stays mounted, and nothing in the app changes the tree: a category the shop
  // saved in the admin shows up when the shopper comes back to 分类, not after a restart.
  useRefetchOnShow(routeKey('catalog.categoryTree'), { when: 'always' });
  const [picked, setPicked] = useState<string | null>(null);
  const [lastParam, setLastParam] = useState(params.categoryId);
  if (params.categoryId !== lastParam) {
    setLastParam(params.categoryId);
    setPicked(null);
  }

  const items = tree.data?.items ?? [];
  const current =
    items.find((top) => top.id === picked) ??
    topLevelOf(items, params.categoryId) ??
    items[0] ??
    null;
  useShare(current ? { route: 'category', params: { categoryId: current.id } } : null, {
    title: current?.name,
  });
  const firstIds = items[0] ? subtreeIds(items[0]).join(',') : '';
  useEffect(() => {
    if (firstIds) rememberFirstCategory(firstIds.split(','));
  }, [firstIds]);

  return (
    <PageShell title="分类" bg="surface">
      <View className="category__search">
        <SearchBar onOpen={() => navigate({ route: 'search', params: {} })} />
      </View>
      {tree.isPending ? (
        <View className="category">
          <View className="category__rail">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="category__rail-skeleton" />
            ))}
          </View>
          <View className="category__main">
            <ProductCardSkeleton layout="list" />
            <ProductCardSkeleton layout="list" />
          </View>
        </View>
      ) : tree.isError ? (
        <ErrorBlock error={tree.error} onRetry={() => tree.refetch()} />
      ) : !current ? (
        <Empty title="暂无分类" description="店铺还没有上架分类" />
      ) : (
        <View className="category">
          <ScrollView scrollY enhanced showScrollbar={false} className="category__rail">
            {items.map((top) => (
              <Pressable
                key={top.id}
                role="tab"
                label={top.name}
                selected={top.id === current.id}
                pressedTint={false}
                className={cx('category__tab', top.id === current.id && 'category__tab--on')}
                onClick={() => {
                  setPicked(top.id);
                  scrollPageToTop();
                }}
              >
                {top.name}
              </Pressable>
            ))}
          </ScrollView>
          <View className="category__main">
            <Pane key={current.id} top={current} showSub={showsSubcategories(config)} />
          </View>
        </View>
      )}
    </PageShell>
  );
}

/**
 * The ids to start a list for before the tree arrives: the first category's, unless the page
 * was opened on a category outside it (a DIY link or a share).
 */
function guessedCategory(linked: string | undefined): string[] | null {
  const ids = recallFirstCategory();
  if (!ids || (linked && !ids.includes(linked))) return null;
  return ids;
}

function Pane({ top, showSub }: { top: TopCategory; showSub: boolean }) {
  const quick = useQuickAdd({ route: 'category', params: { categoryId: top.id } });
  const input = productsOf(subtreeIds(top));
  const products = useInfiniteRouteQuery('catalog.productList', input);
  useRefetchOnShow(routeQueryKey('catalog.productList', input), {
    pages: 'first',
    allPagesAfter: LIST_FULL_RELOAD_AFTER_MS,
  });
  const banner = assetUrl(top.bannerUrl);
  return (
    <>
      {banner ? (
        <View className="category__banner">
          <Image src={banner} label={top.name} ratio={520 / 200} radius="md" />
        </View>
      ) : null}
      {showSub && top.children.length > 0 ? (
        <View className="category__subs">
          {top.children.map((child) => (
            <Pressable
              key={child.id}
              role="link"
              label={child.name}
              className="category__sub"
              onClick={() => navigate({ route: 'productList', params: { categoryId: child.id } })}
            >
              <View className="category__sub-icon">
                <Image src={assetUrl(child.iconUrl)} radius="sm" />
              </View>
              <Text className="category__sub-name">{child.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <InfiniteList
        query={products}
        itemKey={(product) => product.id}
        renderItem={(product) => (
          <ProductCard
            product={product}
            layout="list"
            className="category__product"
            onAddToCart={product.canAddToCart ? () => quick.add(product) : undefined}
          />
        )}
        empty={<Empty compact image="search" title="这个分类还没有商品" />}
        skeleton={
          <>
            <ProductCardSkeleton layout="list" />
            <ProductCardSkeleton layout="list" />
          </>
        }
      />
      {quick.sheet}
    </>
  );
}
