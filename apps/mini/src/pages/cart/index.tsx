import { useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useQueryClient } from '@tanstack/react-query';
import {
  routeKey,
  routeQueryOptions,
  useApiClient,
  useRouteMutation,
  useRouteQuery,
} from '@shop/api-client/react';
import { useTabPage } from '@/app-shell/tab-page';
import { CartRow } from '@/features/cart/cart-row';
import {
  couponHint,
  couponLines,
  selectionOf,
  splitCart,
  type CartItem,
  type CartList,
} from '@/features/cart/cart-view';
import { useQuickAdd } from '@/features/cart/quick-add';
import { CART_KEY, useWholeCart } from '@/features/cart/whole-cart';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { SkuSheet } from '@/features/product/sku-sheet';
import type { SkuMatrix } from '@/features/product/sku-select';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { cx } from '@/lib/cx';
import { navigate, usePullToRefresh } from '@/platform';
import { requireLogin, useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Checkbox } from '@/ui/choice';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { confirm, toast } from '@/ui/feedback';
import { Icon } from '@/ui/icon';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { ProductCard } from '@/ui/product-card';
import { ProductCardSkeleton } from '@/ui/skeleton';
import './index.scss';
import { errorMessage } from '@/lib/error-message';

const HOME = { route: 'home', params: {} } as const;
const HERE = { route: 'cart', params: {} } as const;

/**
 * 购物车 (tab `cart`, pages.md §2.1): the rows that can be bought, ticked on the server
 * (`cart.setSelection`), quantities set outright (`cart.updateItemPut`), 改规格 through the
 * SkuSheet; the greyed 失效商品 with 清空; a coupon line from the shopper's own coupons; 管理
 * (删除, 移入收藏); 结算 hands the ticked rows to 确认订单 in memory; 为你推荐 below.
 */
export default function Cart() {
  useTabPage('cart');
  const signedIn = useSignedIn();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const setDraft = useCheckoutDraft((state) => state.setDraft);
  const [managing, setManaging] = useState(false);
  const [pending, setPending] = useState<Readonly<Record<string, number>>>({});
  const [editing, setEditing] = useState<{ item: CartItem; matrix: SkuMatrix | undefined } | null>(
    null,
  );

  const list = useWholeCart(signedIn);
  useRefetchOnShow(routeKey('cart.list'));
  const recommended = useRouteQuery(
    'catalog.productList',
    { query: { feature: 'recommended', pageSize: 10 } },
    { staleTime: 5 * 60_000 },
  );
  const quick = useQuickAdd(HERE);
  usePullToRefresh(() => Promise.all([list.refetch(), recommended.refetch()]));

  const cart = signedIn ? list.data : undefined;
  const lines = cart ? couponLines(cart) : null;
  const coupons = useRouteQuery(
    'coupon.applicableList',
    { body: { lines: lines ?? [] } },
    { enabled: lines !== null, staleTime: 30_000 },
  );
  const hint = couponHint(coupons.data, lines);

  const update = useRouteMutation('cart.updateItemPut', {
    invalidate: ['cart.list', 'cart.count'],
  });
  const select = useRouteMutation('cart.setSelection');
  const remove = useRouteMutation('cart.removeItems', {
    invalidate: ['cart.list', 'cart.count'],
  });
  // A 商品详情 of a moved item may be cached (opened from here) and would still say 收藏.
  const favorite = useRouteMutation('catalog.favoriteAddBatch', {
    invalidate: ['catalog.favoriteList', 'catalog.productDetail'],
  });

  // One PUT per row at a time: quantities are absolute, and two in flight could land in either
  // order (4 after 5). Taps meanwhile only move the row's next quantity, sent when the PUT lands;
  // the stepper shows the tapped number until the last one is answered.
  const nextQuantity = useRef(new Map<string, number | null>());
  const setQuantity = (item: CartItem, quantity: number) => {
    setPending((now) => ({ ...now, [item.id]: quantity }));
    const queue = nextQuantity.current;
    if (queue.has(item.id)) {
      queue.set(item.id, quantity);
      return;
    }
    queue.set(item.id, null);
    void (async () => {
      let sending: number | null = quantity;
      while (sending !== null) {
        try {
          await update.mutateAsync({ params: { id: item.id }, body: { quantity: sending } });
        } catch (error) {
          toast.text(errorMessage(error));
        }
        sending = queue.get(item.id) ?? null;
        queue.set(item.id, null);
      }
      queue.delete(item.id);
      setPending((now) => {
        const next = { ...now };
        delete next[item.id];
        return next;
      });
    })();
  };

  const setSelected = (body: { itemIds: string[]; all: boolean; isSelected: boolean }) => {
    const before = queryClient.getQueryData<CartList>(CART_KEY);
    if (before) {
      queryClient.setQueryData<CartList>(CART_KEY, {
        ...before,
        items: before.items.map((item) =>
          item.available && (body.all || body.itemIds.includes(item.id))
            ? { ...item, isSelected: body.isSelected }
            : item,
        ),
      });
    }
    select.mutate(
      { body },
      {
        // The answer is the whole cart; an older server answered 20 rows, so re-read then.
        onSuccess: (fresh) =>
          fresh.items.length >= fresh.total
            ? queryClient.setQueryData(CART_KEY, fresh)
            : queryClient.invalidateQueries({ queryKey: CART_KEY }),
        onError: (error) => {
          if (before) queryClient.setQueryData(CART_KEY, before);
          toast.text(errorMessage(error));
        },
      },
    );
  };

  const openSpec = async (item: CartItem) => {
    setEditing({ item, matrix: undefined });
    try {
      const matrix = await queryClient.fetchQuery(
        routeQueryOptions(api, 'catalog.productSkus', { params: { id: item.productId } }),
      );
      setEditing({ item, matrix });
    } catch (error) {
      setEditing(null);
      toast.text(errorMessage(error, '规格加载失败'));
    }
  };

  const selection = cart ? selectionOf(cart) : { all: false, some: false, ids: [] };
  const { available, unavailable } = cart
    ? splitCart(cart.items)
    : { available: [], unavailable: [] };

  const checkout = () => {
    if (!cart || selection.ids.length === 0) {
      toast.text('请选择要结算的商品');
      return;
    }
    const chosen = new Set(selection.ids);
    const names: Record<string, string> = {};
    for (const item of cart.items) if (chosen.has(item.id)) names[item.skuId] = item.productName;
    setDraft({ source: 'cart', cartItemIds: selection.ids, kind: 'normal', names });
    return navigate({ route: 'checkout', params: {} });
  };

  const removeSelected = async () => {
    if (selection.ids.length === 0) {
      toast.text('请选择要删除的商品');
      return;
    }
    const ok = await confirm({
      content: `确定删除选中的 ${selection.ids.length} 件商品吗？`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await remove.mutateAsync({ body: { itemIds: selection.ids, unavailableOnly: false } }).then(
      () => toast.success('已删除'),
      (error: unknown) => toast.text(errorMessage(error)),
    );
  };

  const moveToFavorites = async () => {
    if (!cart || selection.ids.length === 0) {
      toast.text('请选择要移入收藏的商品');
      return;
    }
    const ids = selection.ids;
    const productIds = [
      ...new Set(cart.items.filter((item) => ids.includes(item.id)).map((i) => i.productId)),
    ].slice(0, 50);
    try {
      await favorite.mutateAsync({ body: { productIds } });
      await remove.mutateAsync({ body: { itemIds: ids, unavailableOnly: false } });
      toast.success('已移入收藏');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  };

  const clearUnavailable = async () => {
    const ok = await confirm({
      content: '确定清空所有失效商品吗？',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    await remove.mutateAsync({ body: { itemIds: [], unavailableOnly: true } }).then(
      () => toast.success('已清空'),
      (error: unknown) => toast.text(errorMessage(error)),
    );
  };

  const hasRows = Boolean(cart && cart.items.length > 0);

  const body = !signedIn ? (
    <Empty
      image="cart"
      title="登录后查看购物车"
      description="登录后，加入购物车的商品会一直为你保留"
      actions={
        <Button size="md" onClick={() => requireLogin(HERE)}>
          去登录
        </Button>
      }
    />
  ) : list.isPending ? (
    <View className="cart__loading" id="cart-loading">
      <ProductCardSkeleton layout="list" />
      <ProductCardSkeleton layout="list" />
    </View>
  ) : list.isError ? (
    <ErrorBlock error={list.error} onRetry={() => list.refetch()} />
  ) : !hasRows ? (
    <Empty
      image="cart"
      title="购物车还是空的"
      description="挑几件喜欢的放进来吧"
      actions={
        <Button size="md" variant="outline" onClick={() => navigate(HOME)}>
          回到首页
        </Button>
      }
    />
  ) : (
    <>
      <View className="cart__head">
        <Text className="cart__count">共 {cart?.total ?? 0} 件商品</Text>
        <Pressable
          label={managing ? '完成' : '管理'}
          className="cart__manage"
          onClick={() => setManaging(!managing)}
        >
          {managing ? '完成' : '管理'}
        </Pressable>
      </View>
      {hint && !managing ? (
        <View
          className={cx('cart__coupon', hint.ready && 'cart__coupon--ready')}
          id="cart-coupon-hint"
        >
          <Icon name="coupon" className="cart__coupon-icon" />
          <Text className="cart__coupon-text">{hint.text}</Text>
        </View>
      ) : null}
      {available.length > 0 ? (
        <Card padded={false} className="cart__card" id="cart-available">
          {available.map((item) => (
            <CartRow
              key={item.id}
              item={item}
              quantity={pending[item.id]}
              onSelect={(isSelected) => setSelected({ itemIds: [item.id], all: false, isSelected })}
              onQuantity={(quantity) => setQuantity(item, quantity)}
              onSpec={() => openSpec(item)}
            />
          ))}
        </Card>
      ) : null}
      {unavailable.length > 0 ? (
        <Card
          padded={false}
          className="cart__card"
          id="cart-unavailable"
          title={`失效商品 ${unavailable.length}`}
          extra={
            <Pressable
              label="清空失效商品"
              className="cart__clear"
              onClick={() => clearUnavailable()}
            >
              清空失效商品
            </Pressable>
          }
        >
          {unavailable.map((item) => (
            <CartRow
              key={item.id}
              item={item}
              quantity={pending[item.id]}
              onQuantity={(quantity) => setQuantity(item, quantity)}
            />
          ))}
        </Card>
      ) : null}
    </>
  );

  const picks = recommended.data?.items ?? [];

  return (
    <PageShell title="购物车" className={cx('cart', hasRows && 'cart--with-bar')}>
      {body}
      {picks.length > 0 ? (
        <View className="cart__recommend" id="cart-recommended">
          <Text className="cart__recommend-title">为你推荐</Text>
          <View className="cart__recommend-grid">
            {picks.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onAddToCart={product.canAddToCart ? () => quick.add(product) : undefined}
              />
            ))}
          </View>
        </View>
      ) : null}
      {hasRows ? (
        <View className="cart__bar" id="cart-bar">
          <Checkbox
            label="全选"
            checked={selection.all}
            indeterminate={selection.some && !selection.all}
            disabled={available.length === 0}
            onChange={(isSelected) => setSelected({ itemIds: [], all: true, isSelected })}
          />
          {managing ? (
            <View className="cart__bar-actions">
              <Button
                size="md"
                variant="outline"
                loading={favorite.isPending}
                onClick={() => moveToFavorites()}
              >
                移入收藏
              </Button>
              <Button
                size="md"
                variant="danger"
                loading={remove.isPending}
                onClick={() => removeSelected()}
              >
                删除
              </Button>
            </View>
          ) : (
            <View className="cart__bar-actions">
              <View className="cart__total">
                <Text className="cart__total-label">合计</Text>
                <Price value={cart?.selectedTotal ?? '0.00'} />
              </View>
              <Button size="md" disabled={selection.ids.length === 0} onClick={checkout}>
                {`结算${cart && cart.selectedQuantity > 0 ? `(${cart.selectedQuantity})` : ''}`}
              </Button>
            </View>
          )}
        </View>
      ) : null}
      {editing ? (
        <SkuSheet
          visible
          onClose={() => setEditing(null)}
          product={{
            name: editing.item.productName,
            imageUrl: editing.item.skuImageUrl ?? editing.item.productImageUrl,
            price: editing.item.unitPrice,
            unitName: editing.item.unitName,
          }}
          matrix={editing.matrix}
          actions="confirm"
          skuId={editing.item.skuId}
          initialQuantity={editing.item.quantity}
          busy={update.isPending ? 'confirm' : null}
          onConfirm={(_action, sku, quantity) => {
            const row = editing.item;
            if (sku.id === row.skuId && quantity === row.quantity) {
              setEditing(null);
              return;
            }
            return update
              .mutateAsync({
                params: { id: row.id },
                body: { ...(sku.id === row.skuId ? {} : { skuId: sku.id }), quantity },
              })
              .then(
                () => setEditing(null),
                (error: unknown) => toast.text(errorMessage(error)),
              );
          }}
        />
      ) : null}
      {quick.sheet}
    </PageShell>
  );
}
