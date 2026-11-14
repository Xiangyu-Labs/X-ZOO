import { useEffect, useRef, useState } from 'react';
import { Button as TaroButton, Swiper, SwiperItem, Text, View } from '@tarojs/components';
import { isApiError, type ResponseOf } from '@shop/api-client';
import { routeKey, useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { useDisplay } from '@/app-config';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { useCartCount } from '@/data/cart';
import { useRecordVisit } from '@/data/visits';
import { DescriptionBlocks, hasDescription } from '@/features/content/description-blocks';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { useProductActivities, type ProductActivity } from '@/features/product/activities';
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
import { Countdown } from '@/ui/countdown';
import { ActivitySkuSheet } from '@/features/promo/activity-sku-sheet';
import { startActivityCheckout } from '@/features/promo/checkout';
import { shipText } from '@/features/promo/activity';
import { GroupbuyRules, PresaleRules } from '@/features/promo/promo-rules';
import { OpenTeams } from '@/features/promo/open-teams';
import { useDidShow } from '@tarojs/taro';
import { serverNow } from '@/lib/server-clock';
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
import { VideoPlayer } from '@/ui/video-player';
import { ProductCardSkeleton, Skeleton } from '@/ui/skeleton';
import './index.scss';
import { errorMessage } from '@/lib/error-message';
import { strikePrice } from '@/lib/money';

type Product = ResponseOf<'catalog.productDetail'>;

/** The description through the 富文本 block: the same allow-list, parser and look as DIY. */
/**
 * 商品详情 (`product { id }`, pages.md §2.1): a fixed design (no longer decorated). Gallery,
 * price and sales (under a 拼团 / 预售, its coloured box instead, with the sales in it), 领券,
 * 已选 (the SkuSheet), 服务 and 参数, under a 拼团 the shopper's own open team, its rules and the
 * teams still open (去参团), the review summary with the first reviews, the description, 为你推荐, and
 * the action bar: 客服, 购物车, 收藏, 加入购物车, 立即购买 (under an activity, 立即预订, or
 * 单独购买 and 立即开团 / 查看我的团, in the box's colours).
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
  const shown = useRef(false);
  useDidShow(() => {
    if (!shown.current) {
      shown.current = true;
      return;
    }
    if (id) return refetch();
  });
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
  // Older server responses have no promotion field. A current server's explicit null
  // is authoritative: never choose a different campaign from a secondary list.
  const legacyActivities = useProductActivities(product.id, product.promotion === undefined);
  const currentPromotion = product.promotion;
  const activities: ProductActivity[] =
    product.promotion === undefined
      ? legacyActivities
      : currentPromotion
        ? [
            {
              kind: currentPromotion.kind,
              activityId: currentPromotion.activityId,
              price: currentPromotion.price,
              endAt: currentPromotion.endAt,
              canBuy: currentPromotion.canBuy,
              ...(currentPromotion.seatsRequired === null
                ? {}
                : { seatsRequired: currentPromotion.seatsRequired }),
              note:
                currentPromotion.kind === 'presale'
                  ? shipText(currentPromotion.shipAfterDays ?? 0)
                  : `${currentPromotion.seatsRequired} 人团`,
            },
          ]
        : [];
  const [, setActivityVersion] = useState(0);
  const activity = activities.find((item) => Date.parse(item.endAt) > serverNow());
  const [activitySheet, setActivitySheet] = useState(false);
  const [skuId, setSkuId] = useState<string | undefined>(undefined);
  const presaleDetail = useRouteQuery(
    'presale.detail',
    { params: { id: activity?.activityId ?? '' } },
    { enabled: !currentPromotion && activitySheet && activity?.kind === 'presale' },
  );
  // A 拼团 is read for its rules (how long a team stays open) and, signed in, for the shopper's
  // own open team on it (`myOpenGroupId`): they go to it instead of starting a second one.
  const signedIn = useSignedIn();
  const groupbuyDetail = useRouteQuery(
    'groupbuy.detail',
    { params: { id: activity?.activityId ?? '' } },
    { enabled: activity?.kind === 'groupbuy' },
  );
  // Back from 确认订单 / 收银台 / an order or the team page: whether the shopper now has a team.
  useRefetchOnShow(routeKey('groupbuy.detail'));
  // Read before the session (signed in from 立即开团): `myOpenGroupId` is null until read again.
  const lastSignedIn = useRef(signedIn);
  const refetchGroupbuy = groupbuyDetail.refetch;
  const groupbuyEnabled = activity?.kind === 'groupbuy';
  useEffect(() => {
    if (lastSignedIn.current === signedIn) return;
    lastSignedIn.current = signedIn;
    if (signedIn && groupbuyEnabled) void refetchGroupbuy();
  }, [signedIn, groupbuyEnabled, refetchGroupbuy]);
  const myTeam =
    activity?.kind === 'groupbuy' ? (groupbuyDetail.data?.myOpenGroupId ?? null) : null;
  // The shopper's open team may be one they joined, not one they started (L8).
  const joinedTeam = groupbuyDetail.data?.myOpenGroupRole === 'member';
  const openTeam = (groupId: string) =>
    navigate({ route: 'groupbuyTeam', params: { id: groupId } });
  const activityRead = activity?.kind === 'presale' ? presaleDetail : groupbuyDetail;
  const activityDetail =
    currentPromotion ?? (activity?.kind === 'presale' ? presaleDetail.data : groupbuyDetail.data);
  const selectedActivitySku = activityDetail?.skus.find((sku) => sku.skuId === skuId);
  const activityPrice = selectedActivitySku?.price ?? activity?.price;
  const activityFrom =
    !selectedActivitySku && new Set(activityDetail?.skus.map((sku) => sku.price) ?? []).size > 1;
  const singlePrice = product.skus.find((sku) => sku.id === skuId)?.price ?? product.price;
  const activityStrike = activityPrice ? strikePrice(activityPrice, singlePrice) : null;
  const openActivity = async () => {
    if (!(await requireLogin(route))) return;
    if (!activity || Date.parse(activity.endAt) <= serverNow()) {
      toast.text('活动已结束，请刷新后重试');
      await reload();
      return;
    }
    setActivitySheet(true);
  };
  useDidShow(() => {
    setActivityVersion((value) => value + 1);
  });

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
  const [favorited, setFavorited] = useState<boolean | null>(null);
  const [slide, setSlide] = useState(0);

  const images = product.sliderImages.length > 0 ? product.sliderImages : [product.imageUrl];
  const urls = images.map((src) => assetUrl(src)).filter((src): src is string => !!src);
  // The main video is the first slide; its cover is the 商品缩略图 unless one was picked.
  const video = product.videoUrl
    ? { src: product.videoUrl, poster: product.videoPosterUrl ?? product.imageUrl }
    : null;
  const slides = urls.length + (video ? 1 : 0);
  const soldOut = product.stock <= 0 || product.skus.every((sku) => sku.stock <= 0);
  const strike = strikePrice(product.price, product.originalPrice);
  const canCart = product.canAddToCart && !soldOut && activity === undefined;
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
          circular={slides > 1}
          onChange={(event) => setSlide(event.detail.current)}
        >
          {video ? (
            <SwiperItem key="video">
              <VideoPlayer
                src={video.src}
                poster={video.poster}
                label="商品视频"
                layout="fill"
                active={slide === 0}
              />
            </SwiperItem>
          ) : null}
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
        {slides > 1 ? (
          <Text className="product__counter">
            {slide + 1}/{slides}
          </Text>
        ) : null}
        {soldOut ? <Text className="product__sold-out">已售罄</Text> : null}
      </View>

      {activity ? (
        <View className={`product__promotion product__promotion--${activity.kind}`}>
          <View>
            <Price
              value={activityPrice ?? activity.price}
              prefix={activityFrom ? '起' : undefined}
              size="lg"
              className="product__promotion-price"
            />
            <Text className="product__promotion-label">
              {activity.kind === 'presale' ? '限时预售补贴' : `${activity.seatsRequired}人拼团价`}
            </Text>
            {/* 拼团's note is the team size (2 人团), already in the label beside the price. */}
            {activity.kind === 'presale' ? (
              <Text className="product__promotion-note">{activity.note}</Text>
            ) : null}
            {activityStrike ? (
              <Price
                value={activityStrike}
                size="sm"
                strike
                className="product__promotion-original"
              />
            ) : null}
            {product.salesDisplay > 0 ? (
              <Text className="product__promotion-sales">
                已售 {formatSales(product.salesDisplay)}
              </Text>
            ) : null}
          </View>
          <View>
            <Text>距结束剩</Text>
            <Countdown
              endsAt={activity.endAt}
              format="dhms"
              variant="boxed"
              onEnd={() => {
                setActivityVersion((value) => value + 1);
                return reload();
              }}
            />
          </View>
        </View>
      ) : null}
      <View className="product__summary">
        {/* Not `hidden`: WeChat lets the row's own `display: flex` win over it, so the plain
            price showed under the activity's box. Under an activity, the box is the price. */}
        {activity === undefined ? (
          <View className="product__price-row">
            <Price value={product.price} size="lg" />
            {strike ? <Price value={strike} size="sm" strike /> : null}
            {product.salesDisplay > 0 ? (
              <Text className="product__sales">已售 {formatSales(product.salesDisplay)}</Text>
            ) : null}
          </View>
        ) : null}
        <View className="product__title-row">
          <Text className="product__name" id="product-name" userSelect>
            {product.name}
            {activity?.kind === 'presale' ? (
              <Text className="product__presale-badge">预售</Text>
            ) : null}
          </Text>
          <Pressable label="分享" className="product__share" onClick={() => setSheet('share')}>
            <Icon name="share" />
            <Text className="product__share-text">分享</Text>
          </Pressable>
        </View>
        {product.subtitle ? <Text className="product__subtitle">{product.subtitle}</Text> : null}
      </View>

      {myTeam ? (
        <View className="product__mine" id="product-my-team">
          <Cell
            title={joinedTeam ? '你参加的团正在拼' : '你发起的团正在拼'}
            label={joinedTeam ? '查看我参加的团' : '查看我发起的团'}
            value="查看进度"
            icon="group"
            onClick={() => openTeam(myTeam)}
          />
        </View>
      ) : null}

      <View className="product__cells">
        <ProductCoupons productId={product.id} redirect={route} />
        <Cell
          title="已选"
          label={`选择规格，${chosenText}`}
          value={chosenText}
          // In a team already, 立即开团 is 查看我的团: the spec is chosen for 单独购买.
          onClick={() =>
            activity && !myTeam ? openActivity() : openSku(canCart ? ['cart', 'buy'] : ['buy'])
          }
          disabled={soldOut || product.promotionConflict === true}
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

      {activity?.kind === 'groupbuy' && groupbuyDetail.data ? (
        <GroupbuyRules
          seatsRequired={groupbuyDetail.data.seatsRequired}
          groupTtlSeconds={groupbuyDetail.data.groupTtlSeconds}
          perOrderQuantity={groupbuyDetail.data.perOrderQuantity}
        />
      ) : null}

      {currentPromotion?.kind === 'presale' ? (
        <PresaleRules
          shipAfterDays={currentPromotion.shipAfterDays ?? 0}
          perOrderQuantity={currentPromotion.perOrderQuantity}
        />
      ) : null}

      {activity?.kind === 'groupbuy' && activity.canBuy && !product.promotionConflict ? (
        <OpenTeams activityId={activity.activityId} exclude={myTeam} onOpen={openTeam} />
      ) : null}

      {display.productReviews ? <Reviews product={product} /> : null}

      <Card title="商品详情" className="product__description" id="product-description">
        {hasDescription(product.descriptionBlocks, product.descriptionHtml) ? (
          <DescriptionBlocks blocks={product.descriptionBlocks} html={product.descriptionHtml} />
        ) : (
          <Text className="product__muted">暂无图文详情</Text>
        )}
      </Card>

      {display.productRecommendations ? <Recommended productId={product.id} /> : null}

      <ActionBar icons={icons}>
        {product.promotionConflict ? (
          <Button size="lg" block disabled>
            暂不可购买
          </Button>
        ) : activity ? (
          <>
            {activity.kind === 'groupbuy' ? (
              <Button
                size="lg"
                variant="secondary"
                block
                className="product__buy product__buy--groupbuy-single"
                label={`单独购买 ¥${singlePrice}`}
                disabled={soldOut}
                onClick={() => openSku(['buy'])}
              >
                <BuyLabel price={`¥${singlePrice}`} action="单独购买" />
              </Button>
            ) : null}
            {myTeam ? (
              <Button
                size="lg"
                block
                className="product__buy product__buy--groupbuy"
                onClick={() => openTeam(myTeam)}
              >
                查看我的团
              </Button>
            ) : (
              <Button
                size="lg"
                block
                className={`product__buy product__buy--${activity.kind}`}
                disabled={!activity.canBuy}
                onClick={openActivity}
                {...(activity.canBuy
                  ? {
                      label: `${activity.kind === 'groupbuy' ? '立即开团' : '立即预订'} ¥${activityPrice}${activityFrom ? '起' : ''}`,
                    }
                  : {})}
              >
                {!activity.canBuy ? (
                  '已售罄'
                ) : activity.kind === 'groupbuy' ? (
                  // Two buttons beside three icons: price over action, or 「立即开团 ¥49.00起」
                  // runs past the bar on a 375 px phone.
                  <BuyLabel
                    price={`¥${activityPrice}${activityFrom ? '起' : ''}`}
                    action="立即开团"
                  />
                ) : (
                  `立即预订 ¥${activityPrice}${activityFrom ? '起' : ''}`
                )}
              </Button>
            )}
          </>
        ) : soldOut ? (
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

      {activity && !activityDetail ? (
        <Sheet visible={activitySheet} onClose={() => setActivitySheet(false)} title="选择规格">
          {activityRead.isError ? (
            <ErrorBlock error={activityRead.error} onRetry={() => activityRead.refetch()} />
          ) : (
            <Skeleton />
          )}
        </Sheet>
      ) : null}
      {activity && activityDetail ? (
        <ActivitySkuSheet
          visible={activitySheet}
          initialSkuId={skuId}
          onSelect={(sku) => {
            setSkuId(sku.skuId);
          }}
          onClose={() => setActivitySheet(false)}
          title={product.name}
          imageUrl={product.imageUrl}
          skus={activityDetail.skus}
          perOrderQuantity={activityDetail.perOrderQuantity}
          confirmText={activity.kind === 'groupbuy' ? '立即开团' : '立即预订'}
          onConfirm={(sku, quantity) => {
            setSkuId(sku.skuId);
            setActivitySheet(false);
            return startActivityCheckout({
              kind: activity.kind,
              activityId: activity.activityId,
              skuId: sku.skuId,
              quantity,
            });
          }}
        />
      ) : null}
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

/** A buy button's two lines: the price, and under it what the tap does. */
function BuyLabel({ price, action }: { price: string; action: string }) {
  return (
    <View className="product__buy-label">
      <Text className="product__buy-price">{price}</Text>
      <Text className="product__buy-action">{action}</Text>
    </View>
  );
}
