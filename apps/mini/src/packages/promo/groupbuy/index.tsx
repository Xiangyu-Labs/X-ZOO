import { Swiper, SwiperItem, Text, View } from '@tarojs/components';
import { useInfiniteRouteQuery, useRouteQuery } from '@shop/api-client/react';
import { activityCard, activityPhase } from '@/features/promo/activity';
import { parseQuery } from '@/lib/query';
import { serverNow } from '@/lib/server-clock';
import { decodeEnter, navigate, useShare } from '@/platform';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { Image } from '@/ui/image';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { ProductCard } from '@/ui/product-card';
import { ProductCardSkeleton } from '@/ui/skeleton';
import './index.scss';

const ROUTE = { route: 'groupbuyList', params: {} } as const;

/** A banner's link, when it is a page of this app (legacy uni-app paths open nothing). */
function bannerRoute(link: string | null) {
  if (!link) return null;
  const [path = '', search = ''] = link.split('?');
  const query = parseQuery(search);
  return decodeEnter({ path, query }).route;
}

/**
 * 拼团 (`groupbuyList`, pages.md §2.5): the operator's banners, how many are taking part right
 * now, and the activities. A card opens the activity (`groupbuy { id }`).
 *
 * `groupbuy.summary` also returns participants' avatars; they are not shown (a shopper's face
 * next to this shop's products is not something to put on a public page).
 */
export default function GroupbuyListPage() {
  useShare(ROUTE, { title: '拼团' });
  const banners = useRouteQuery('groupbuy.banners', undefined, { staleTime: 5 * 60_000 });
  const summary = useRouteQuery('groupbuy.summary', undefined, { staleTime: 60_000 });
  const list = useInfiniteRouteQuery('groupbuy.list', { query: { pageSize: 20 } });
  const slides = banners.data?.items ?? [];
  const participants = summary.data?.participants ?? 0;

  return (
    <PageShell title="拼团">
      <View className="groupbuy-list" id="groupbuy-list">
        {slides.length > 0 ? (
          <Swiper
            className="groupbuy-list__banner"
            autoplay={slides.length > 1}
            circular
            indicatorDots={slides.length > 1}
          >
            {slides.map((slide, index) => {
              const route = bannerRoute(slide.link);
              return (
                <SwiperItem key={index}>
                  {route ? (
                    <Pressable label={`拼团活动 ${index + 1}`} onClick={() => navigate(route)}>
                      <Image src={slide.imageUrl} ratio={750 / 320} radius="md" lazy={false} />
                    </Pressable>
                  ) : (
                    <Image src={slide.imageUrl} ratio={750 / 320} radius="md" lazy={false} />
                  )}
                </SwiperItem>
              );
            })}
          </Swiper>
        ) : null}
        <View className="groupbuy-list__intro">
          <Text className="groupbuy-list__rule">
            人满即成团；到时间未凑齐，拼团自动取消，已付款项原路退回
          </Text>
          {participants > 0 ? (
            <Text className="groupbuy-list__count">{participants} 人正在拼团</Text>
          ) : null}
        </View>
        <InfiniteList
          query={list}
          itemKey={(card) => card.activityId}
          className="groupbuy-list__items"
          renderItem={(card) => {
            const { product, activityPrice } = activityCard(card);
            const phase = activityPhase(card, serverNow());
            return (
              <ProductCard
                product={product}
                layout="list"
                activity={phase === 'upcoming' ? '即将开始' : `${card.seatsRequired}人团`}
                activityPrice={activityPrice}
                onClick={() => navigate({ route: 'groupbuy', params: { id: card.activityId } })}
              />
            );
          }}
          skeleton={[0, 1, 2].map((key) => (
            <ProductCardSkeleton key={key} layout="list" />
          ))}
          empty={
            <Empty
              image="cart"
              title="暂时没有拼团活动"
              actions={
                <Button variant="outline" onClick={() => navigate({ route: 'home', params: {} })}>
                  回到首页
                </Button>
              }
            />
          }
        />
      </View>
    </PageShell>
  );
}
