import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useInfiniteRouteQuery, useRouteQuery } from '@shop/api-client/react';
import { useQuickAdd } from '@/features/cart/quick-add';
import { categoryName } from '@/features/catalog/category-tree';
import {
  listQuery,
  nextPriceSort,
  normalisePrice,
  NO_PRICE,
  type ListSort,
  type PriceRange,
} from '@/features/catalog/list-query';
import { cx } from '@/lib/cx';
import { navigate, storage, useRouteParams, useShare } from '@/platform';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { Field } from '@/ui/field';
import { Icon } from '@/ui/icon';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { ProductCard } from '@/ui/product-card';
import { SearchBar } from '@/ui/search-bar';
import { Sheet } from '@/ui/sheet';
import { ProductCardSkeleton } from '@/ui/skeleton';
import './index.scss';

type Layout = 'grid' | 'list';
const LAYOUT_KEY = 'shop.productList.layout';

const readLayout = (): Layout => (storage.get(LAYOUT_KEY) === 'list' ? 'list' : 'grid');
const isPriceSort = (sort: ListSort) => sort === 'price-asc' || sort === 'price-desc';

/**
 * 商品列表 (`productList { categoryId?, keyword?, labelId?, couponId? }`, pages.md §2.2): the
 * title follows the category or the keyword; 综合 / 销量 / 新品 / 价格 sort, a price filter,
 * two columns or one (remembered), and 加购 on each card.
 *
 * `couponId` (我的优惠券 / 领券中心「去使用」) is a coupon **template** id: the server lists the
 * products that coupon covers (H4, COUPON-009).
 */
export default function ProductList() {
  const params = useRouteParams('productList');
  const { categoryId, keyword, labelId, couponId } = params;
  const tree = useRouteQuery('catalog.categoryTree', undefined, {
    staleTime: 5 * 60_000,
    enabled: Boolean(categoryId),
  });
  const [sort, setSort] = useState<ListSort>('default');
  const [price, setPrice] = useState<PriceRange>(NO_PRICE);
  const [draft, setDraft] = useState<PriceRange>(NO_PRICE);
  const [filterOpen, setFilterOpen] = useState(false);
  const [layout, setLayout] = useState<Layout>(readLayout);

  const waitingForTree = Boolean(categoryId) && tree.isPending;
  const query = listQuery({
    categoryId,
    keyword,
    labelId,
    couponId,
    sort,
    price,
    tree: tree.data,
  });
  const products = useInfiniteRouteQuery(
    'catalog.productList',
    { query },
    { enabled: !waitingForTree },
  );
  const quick = useQuickAdd({ route: 'productList', params });

  const title =
    (categoryId && tree.data ? categoryName(tree.data.items, categoryId) : null) ??
    keyword ??
    '商品列表';
  useShare({ route: 'productList', params }, { title });

  const toggleLayout = () => {
    const next: Layout = layout === 'grid' ? 'list' : 'grid';
    setLayout(next);
    storage.set(LAYOUT_KEY, next);
  };
  const filtered = price.from !== '' || price.to !== '';

  const sortItem = (key: ListSort, label: string) => (
    <Pressable
      label={label}
      selected={sort === key}
      pressedTint={false}
      className={cx('goods-list__sort', sort === key && 'goods-list__sort--on')}
      onClick={() => setSort(key)}
    >
      {label}
    </Pressable>
  );

  return (
    <PageShell title={title}>
      <View className="goods-list__head">
        <SearchBar
          placeholder={keyword || '搜索商品'}
          onOpen={() =>
            navigate({ route: 'search', params: keyword ? { keyword } : {} }, { replace: true })
          }
        />
        <View className="goods-list__sorts" ariaRole="toolbar" ariaLabel="排序和筛选">
          {sortItem('default', '综合')}
          {sortItem('sales', '销量')}
          {sortItem('new', '新品')}
          <Pressable
            label={
              sort === 'price-asc'
                ? '价格从低到高'
                : sort === 'price-desc'
                  ? '价格从高到低'
                  : '价格'
            }
            selected={isPriceSort(sort)}
            pressedTint={false}
            className={cx('goods-list__sort', isPriceSort(sort) && 'goods-list__sort--on')}
            onClick={() => setSort(nextPriceSort(sort))}
          >
            价格
            <Icon
              name={sort === 'price-desc' ? 'chevron-down' : 'chevron-up'}
              className="goods-list__sort-icon"
            />
          </Pressable>
          <Pressable
            label="筛选"
            selected={filtered}
            pressedTint={false}
            className={cx('goods-list__sort', filtered && 'goods-list__sort--on')}
            onClick={() => {
              setDraft(price);
              setFilterOpen(true);
            }}
          >
            筛选
            <Icon name="filter" className="goods-list__sort-icon" />
          </Pressable>
          <Pressable
            label={layout === 'grid' ? '切换为单列' : '切换为双列'}
            className="goods-list__layout"
            onClick={toggleLayout}
          >
            <Icon name={layout === 'grid' ? 'list' : 'grid'} />
          </Pressable>
        </View>
      </View>
      <View className="goods-list__body">
        <InfiniteList
          key={JSON.stringify(query)}
          query={products}
          columns={layout === 'grid' ? 2 : 1}
          itemKey={(product) => product.id}
          renderItem={(product) => (
            <ProductCard
              product={product}
              layout={layout}
              onAddToCart={product.canAddToCart ? () => quick.add(product) : undefined}
            />
          )}
          empty={
            <Empty
              compact
              image="search"
              title={keyword ? `没有找到「${keyword}」相关的商品` : '暂时没有商品'}
              description={filtered ? '换个价格区间试试' : '换个关键词或分类看看'}
            />
          }
          skeleton={
            layout === 'grid' ? (
              <View className="goods-list__skeleton-grid">
                {[0, 1, 2, 3].map((index) => (
                  <ProductCardSkeleton key={index} />
                ))}
              </View>
            ) : (
              <>
                <ProductCardSkeleton layout="list" />
                <ProductCardSkeleton layout="list" />
              </>
            )
          }
        />
      </View>
      <Sheet
        visible={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="筛选"
        footer={
          <View className="goods-list__filter-actions">
            <Button variant="outline" block onClick={() => setDraft(NO_PRICE)}>
              重置
            </Button>
            <Button
              block
              onClick={() => {
                setPrice(normalisePrice(draft));
                setFilterOpen(false);
              }}
            >
              确定
            </Button>
          </View>
        }
      >
        <Text className="goods-list__filter-title">价格区间（元）</Text>
        <View className="goods-list__price">
          <Field
            type="digit"
            placeholder="最低价"
            value={draft.from}
            onChange={(from) => setDraft({ ...draft, from })}
            className="goods-list__price-field"
          />
          <Text className="goods-list__price-dash">—</Text>
          <Field
            type="digit"
            placeholder="最高价"
            value={draft.to}
            onChange={(to) => setDraft({ ...draft, to })}
            className="goods-list__price-field"
          />
        </View>
      </Sheet>
      {quick.sheet}
    </PageShell>
  );
}
