import { useEffect, useRef, useState } from 'react';
import { Button as TaroButton, Swiper, SwiperItem, Text, View } from '@tarojs/components';
import { isApiError, type ResponseOf } from '@shop/api-client';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { useDisplay } from '@/app-config';
import { useCartCount } from '@/data/cart';
import { useRecordVisit } from '@/data/visits';
import { RichContent } from '@/features/content/rich-content';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { useProductActivities } from '@/features/product/activities';
import { ProductCoupons } from '@/features/product/product-coupons';
import { ReviewItem } from '@/features/product/review-item';
import {
  RECOMMENDED_INPUT,
  RECOMMENDED_STALE_TIME,
  firstReviewsInput,
  usePrefetchProductReads,
} from '@/features/product/secondary-reads';
import { SkuSheet, type SkuAction } from '@/features/product/sku-sheet';
import { initialSelection, selectionText, specsOf } from '@/features/product/sku-select';
import { PosterHost, openPoster, useProductPosterEnabled } from '@/features/share/poster';
import { assetUrl } from '@/lib/asset-url';
import { navigate, previewImages, useRouteParams, useShare } from '@/platform';
import { requireLogin, useSignedIn } from '@/session/session';
import { ActionBar, type ActionBarIcon } from '@/ui/action-bar';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Cell } from '@/ui/cell';
import { sessionFromOf, useContactIcon } from '@/ui/contact-button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { ProductCard, formatSales } from '@/ui/product-card';
import { Sheet } from '@/ui/sheet';
import { ProductCardSkeleton, Skeleton } from '@/ui/skeleton';
import './index.scss';
import { errorMessage } from '@/lib/error-message';
import { strikePrice } from '@/lib/money';

type Product = ResponseOf<'catalog.productDetail'>;

/** The description through the 富文本 block: the same allow-list, parser and look as DIY. */
/**
 * 商品详情 (`product { id }`, pages.md §2.1): a fixed design (no longer decorated). Gallery,
 * price and sales, 拼团 / 预售 entry bars, 领券, 已选 (the SkuSheet), 服务 and 参数, the review
 * summary with the first reviews, the description, 为你推荐, and the action bar: 客服, 购物车,
 * 收藏, 加入购物车, 立即购买.
 *
 * Browsing needs no session; 加入购物车, 立即购买, 收藏 and 领券 go through `requireLogin`. An
 * off-shelf or deleted product answers 404 (`catalog.productDetail` never returns one), shown
 * as 「商品已下架」.
 *
 * `app/config.display` (小程序外观 → 页面显示) switches 评价, 为你推荐, 服务 and 生成海报 off;
 * each shows by default.
 */
export default function ProductPage() {
  const { id = '' } = useRouteParams('product');
  const product = useRouteQuery(
    'catalog.productDetail',
    { params: { id } },
    { enabled: id !== '' },
  );
  // Read before there was a session (a shared link opened while the silent login ran, or
  // signed in from 收藏 itself), the product says `favorited: null`: read it again signed in,
  // or the heart says 未收藏 for a product the shopper has kept.
  const signedIn = useSignedIn();
  const favoriteUnknown = product.data?.favorited === null;
  const { refetch } = product;
  useEffect(() => {
    if (signedIn && favoriteUnknown) void refetch();
  }, [signedIn, favoriteUnknown, refetch]);
  // 拼团 / 预售, 领券, 评价 and 为你推荐 need only the id: asked for now, not after the product.
  usePrefetchProductReads(id);
  useRecordVisit('product');
  useShare(id ? { route: 'product', params: { id } } : null, {
    title: product.data?.name,
    imageUrl: assetUrl(product.data?.imageUrl) ?? undefined,
  });

  if (id === '') {
    return (
      <PageShell title="商品详情">
        <Empty title="没有指定商品" />
      </PageShell>
    );
  }
  if (product.isPending) return <DetailSkeleton />;
  if (product.isError) {
    if (isApiError(product.error) && product.error.code === 'CATALOG_PRODUCT_NOT_FOUND') {
      return (
        <PageShell title="商品详情">
          <View className="product__gone" id="product-gone">
            <Empty
              image="search"
              title="商品已下架"
              description="这件商品已经下架或不存在，去看看别的吧"
              actions={
                <Button onClick={() => navigate({ route: 'home', params: {} })}>回到首页</Button>
              }
            />
          </View>
        </PageShell>
      );
    }
    return (
      <PageShell title="商品详情">
        <ErrorBlock error={product.error} onRetry={() => product.refetch()} />
      </PageShell>
    );
  }
  return <Detail product={product.data} reload={() => refetch().then((read) => read.data)} />;
}

function Detail({
  product,
  reload,
}: {
  product: Product;
  /** Reads the product again (signed in now, to learn whether it is kept). */
  reload: () => Promise<Product | undefined>;
}) {
  const route = { route: 'product' as const, params: { id: product.id } };
  const setDraft = useCheckoutDraft((state) => state.setDraft);
  const cartCount = useCartCount();
  const contact = useContactIcon(sessionFromOf('product', product.id));
  const activities = useProductActivities(product.id);
  const display = useDisplay();
  const posterEnabled = useProductPosterEnabled();
  const addItem = useRouteMutation('cart.addItem', { invalidate: ['cart.list', 'cart.count'] });
  // 我的收藏 may sit under this page (opened from it), and so may another 商品详情 of the same
  // product (recommended from a product it was opened from), which would still say 收藏.
  const favoriteAdd = useRouteMutation('catalog.favoriteAdd', {
    invalidate: ['catalog.favoriteList', 'catalog.productDetail'],
  });
  const favoriteRemove = useRouteMutation('catalog.favoriteRemove', {
    invalidate: ['catalog.favoriteList', 'catalog.productDetail'],
  });
  const favoriteInFlight = useRef(false);

  const [sheet, setSheet] = useState<'sku' | 'service' | 'params' | 'share' | null>(null);
  const [actions, setActions] = useState<readonly SkuAction[]>(['cart', 'buy']);
  const [skuId, setSkuId] = useState<string | undefined>(undefined);
  const [favorited, setFavorited] = useState<boolean | null>(null);
  const [slide, setSlide] = useState(0);

  const images = product.sliderImages.length > 0 ? product.sliderImages : [product.imageUrl];
  const urls = images.map((src) => assetUrl(src)).filter((src): src is string => !!src);
  const soldOut = product.stock <= 0 || product.skus.every((sku) => sku.stock <= 0);
  const strike = strikePrice(product.price, product.originalPrice);
  const canCart = product.canAddToCart && !soldOut;
  const isFavorite = favorited ?? product.favorited === true;
  const matrix = { specs: product.specs, skus: product.skus };
  const picked = skuId ? initialSelection(matrix, skuId) : {};
  const chosenText =
    specsOf(matrix).length === 0 ? '默认规格' : selectionText(matrix, picked).replace('已选 ', '');

  const openSku = async (which: readonly SkuAction[]) => {
    if (!(await requireLogin(route))) return;
    setActions(which);
    setSheet('sku');
  };

  const toggleFavorite = async () => {
    // A second tap before the first is answered would race a remove against the add (or the
    // other way round), and the heart could end up saying the opposite of the server.
    if (favoriteInFlight.current) return;
    favoriteInFlight.current = true;
    try {
      if (!(await requireLogin(route))) return;
      // Signed in by this tap: whether it is kept is known only after reading it again.
      const kept =
        favorited ??
        (product.favorited === null ? (await reload())?.favorited : product.favorited) === true;
      const next = !kept;
      setFavorited(next);
      try {
        if (next) await favoriteAdd.mutateAsync({ body: { productId: product.id } });
        else await favoriteRemove.mutateAsync({ params: { productId: product.id } });
        toast.text(next ? '已收藏' : '已取消收藏');
      } catch (error) {
        setFavorited(!next);
        toast.text(errorMessage(error, '操作失败，请稍后重试'));
      }
    } finally {
      favoriteInFlight.current = false;
    }
  };

  const confirm = (action: SkuAction | 'confirm', sku: { id: string }, quantity: number) => {
    setSkuId(sku.id);
    if (action === 'buy') {
      setDraft({
        source: 'buy-now',
        item: { skuId: sku.id, quantity },
        kind: 'normal',
        names: { [sku.id]: product.name },
      });
      setSheet(null);
      return navigate({ route: 'checkout', params: {} });
    }
    return addItem.mutateAsync({ body: { skuId: sku.id, quantity } }).then(
      () => {
        toast.success('已加入购物车');
        setSheet(null);
      },
      (error: unknown) => toast.text(errorMessage(error)),
    );
  };

  const icons: ActionBarIcon[] = [
    ...(contact ? [contact] : []),
    {
      icon: 'cart',
      label: '购物车',
      badge: cartCount,
      onClick: () => void navigate({ route: 'cart', params: {} }),
    },
    {
      icon: isFavorite ? 'heart-fill' : 'heart',
      label: isFavorite ? '已收藏' : '收藏',
      active: isFavorite,
      onClick: () => toggleFavorite(),
    },
  ];

  return (
    <PageShell title="商品详情" withBar>
      <View className="product__gallery">
        <Swiper
          className="product__swiper"
          circular={urls.length > 1}
          onChange={(event) => setSlide(event.detail.current)}
        >
          {urls.map((src, index) => (
            <SwiperItem key={src}>
              <Pressable
                label={`查看大图，第 ${index + 1} 张`}
                pressedTint={false}
                onClick={() => previewImages(urls, src)}
              >
                <Image src={src} label={index === 0 ? product.name : undefined} lazy={false} />
              </Pressable>
            </SwiperItem>
          ))}
        </Swiper>
        {urls.length > 1 ? (
          <Text className="product__counter">
            {slide + 1}/{urls.length}
          </Text>
        ) : null}
        {soldOut ? <Text className="product__sold-out">已售罄</Text> : null}
      </View>

      <View className="product__summary">
        <View className="product__price-row">
          <Price value={product.price} size="lg" />
          {strike ? <Price value={strike} size="sm" strike /> : null}
          {product.salesDisplay > 0 ? (
            <Text className="product__sales">已售 {formatSales(product.salesDisplay)}</Text>
          ) : null}
        </View>
        <View className="product__title-row">
          <Text className="product__name" id="product-name" userSelect>
            {product.name}
          </Text>
          <Pressable label="分享" className="product__share" onClick={() => setSheet('share')}>
            <Icon name="share" />
            <Text className="product__share-text">分享</Text>
          </Pressable>
        </View>
        {product.subtitle ? <Text className="product__subtitle">{product.subtitle}</Text> : null}
      </View>

      {activities.length > 0 ? (
        <View className="product__activities">
          {activities.map((activity) => (
            <Pressable
              key={`${activity.kind}-${activity.activityId}`}
              role="link"
              label={`${activity.kind === 'groupbuy' ? '拼团' : '预售'} ¥${activity.price}，${activity.note}`}
              className="product__activity"
              onClick={() =>
                navigate({ route: activity.kind, params: { id: activity.activityId } })
              }
            >
              <Text className="product__activity-kind">
                {activity.kind === 'groupbuy' ? '拼团' : '预售'}
              </Text>
              <Price value={activity.price} size="sm" />
              <Text className="product__activity-note">{activity.note}</Text>
              <Text className="product__activity-go">
                {activity.kind === 'groupbuy' ? '去拼团' : '去预订'}
              </Text>
              <Icon name="chevron-right" />
            </Pressable>
          ))}
        </View>
      ) : null}

      <View className="product__cells">
        <ProductCoupons productId={product.id} redirect={route} />
        <Cell
          title="已选"
          label={`选择规格，${chosenText}`}
          value={chosenText}
          onClick={() => openSku(canCart ? ['cart', 'buy'] : ['buy'])}
          disabled={soldOut}
        />
        {display.productServiceTags && product.protections.length > 0 ? (
          <Cell
            title="服务"
            label="查看服务说明"
            value={product.protections.map((item) => item.title).join(' · ')}
            onClick={() => setSheet('service')}
          />
        ) : null}
        {product.params.length > 0 ? (
          <Cell
            title="参数"
            label="查看商品参数"
            value={product.params
              .slice(0, 2)
              .map((item) => item.name)
              .join(' ')}
            onClick={() => setSheet('params')}
          />
        ) : null}
      </View>

      {display.productReviews ? <Reviews product={product} /> : null}

      <Card title="商品详情" className="product__description" id="product-description">
        {product.descriptionHtml.trim() ? (
          <RichContent html={product.descriptionHtml} />
        ) : (
          <Text className="product__muted">暂无图文详情</Text>
        )}
      </Card>

      {display.productRecommendations ? <Recommended productId={product.id} /> : null}

      <ActionBar icons={icons}>
        {soldOut ? (
          <Button size="lg" block disabled>
            已售罄
          </Button>
        ) : (
          <>
            {canCart ? (
              <Button size="lg" variant="secondary" block onClick={() => openSku(['cart'])}>
                加入购物车
              </Button>
            ) : null}
            <Button size="lg" block onClick={() => openSku(['buy'])}>
              立即购买
            </Button>
          </>
        )}
      </ActionBar>

      <SkuSheet
        visible={sheet === 'sku'}
        onClose={() => setSheet(null)}
        product={product}
        matrix={matrix}
        actions={actions}
        skuId={skuId}
        busy={addItem.isPending ? 'cart' : null}
        onConfirm={confirm}
      />
      <Sheet visible={sheet === 'service'} onClose={() => setSheet(null)} title="服务说明">
        <View className="product__sheet-list">
          {product.protections.map((item) => (
            <View key={item.id} className="product__sheet-item">
              <Text className="product__sheet-title">{item.title}</Text>
              {item.content ? <Text className="product__muted">{item.content}</Text> : null}
            </View>
          ))}
        </View>
      </Sheet>
      <Sheet visible={sheet === 'params'} onClose={() => setSheet(null)} title="商品参数">
        <View className="product__params">
          {product.params.map((item) => (
            <View key={item.name} className="product__param">
              <Text className="product__param-name">{item.name}</Text>
              <Text className="product__param-value">{item.value}</Text>
            </View>
          ))}
        </View>
      </Sheet>
      <Sheet visible={sheet === 'share'} onClose={() => setSheet(null)} title="分享给好友">
        <View className="product__share-options">
          <TaroButton
            className="product__share-option"
            openType="share"
            ariaLabel="发送给微信好友"
            onClick={() => setSheet(null)}
          >
            <Icon name="message" />
            <Text>微信好友</Text>
          </TaroButton>
          {posterEnabled ? (
            <Pressable
              label="生成分享海报"
              className="product__share-option"
              onClick={() => {
                setSheet(null);
                openPoster({ kind: 'product', id: product.id });
              }}
            >
              <Icon name="image-plus" />
              <Text>生成海报</Text>
            </Pressable>
          ) : null}
        </View>
      </Sheet>
      {posterEnabled ? (
        <PosterHost
          subject={{ kind: 'product', id: product.id }}
          content={{
            title: product.name,
            price: product.price,
            originalPrice: product.originalPrice,
            imageUrl: product.imageUrl,
          }}
        />
      ) : null}
    </PageShell>
  );
}

function Reviews({ product }: { product: Product }) {
  const summary = product.reviewSummary;
  const first = useRouteQuery('catalog.productReviews', firstReviewsInput(product.id), {
    enabled: summary.total > 0,
  });
  const open = () => void navigate({ route: 'productReviews', params: { productId: product.id } });
  return (
    <Card
      title={`评价 (${summary.total})`}
      className="product__reviews"
      id="product-reviews"
      extra={
        summary.total > 0 ? (
          <Pressable label={`好评率 ${summary.goodRate}%，查看全部评价`} role="link" onClick={open}>
            <Text className="product__good-rate">好评率 {summary.goodRate}%</Text>
            <Icon name="chevron-right" />
          </Pressable>
        ) : undefined
      }
    >
      {summary.total === 0 ? (
        <Text className="product__muted">还没有评价</Text>
      ) : (
        <View className="product__review-list">
          {(first.data?.items ?? []).map((review) => (
            <ReviewItem key={review.id} review={review} clamp />
          ))}
        </View>
      )}
    </Card>
  );
}

function Recommended({ productId }: { productId: string }) {
  const list = useRouteQuery('catalog.productList', RECOMMENDED_INPUT, {
    staleTime: RECOMMENDED_STALE_TIME,
  });
  const items = (list.data?.items ?? []).filter((item) => item.id !== productId).slice(0, 6);
  if (items.length === 0) return null;
  return (
    <View className="product__recommended" id="product-recommended">
      <Text className="product__section-title">为你推荐</Text>
      <View className="product__recommended-grid">
        {items.map((item) => (
          <ProductCard key={item.id} product={item} />
        ))}
      </View>
    </View>
  );
}

function DetailSkeleton() {
  return (
    <PageShell title="商品详情">
      <View className="product__skeleton" id="product-loading">
        <Skeleton className="product__skeleton-gallery" />
        <View className="product__summary">
          <Skeleton className="product__skeleton-line" />
          <Skeleton className="product__skeleton-line product__skeleton-line--short" />
        </View>
        <ProductCardSkeleton layout="list" />
      </View>
    </PageShell>
  );
}
