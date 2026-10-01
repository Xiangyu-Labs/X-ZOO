import { useState } from 'react';
import { View } from '@tarojs/components';
import { isApiError, type ResponseOf } from '@shop/api-client';
import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import {
  ActivityDescription,
  ActivityHero,
  ActivityNotes,
  ActivitySkeleton,
} from '@/features/promo/activity-hero';
import { ActivitySkuSheet } from '@/features/promo/activity-sku-sheet';
import {
  PHASE_BUTTON,
  activityDeadline,
  activityPhase,
  salesText,
  shipText,
} from '@/features/promo/activity';
import { startActivityCheckout } from '@/features/promo/checkout';
import { ShareSheet } from '@/features/share/share-sheet';
import { assetUrl } from '@/lib/asset-url';
import { serverNow } from '@/lib/server-clock';
import { leaveFor, navigate, useRouteParams, useShare } from '@/platform';
import { requireLogin } from '@/session/session';
import { ActionBar } from '@/ui/action-bar';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { PageShell } from '@/ui/page-shell';
import './index.scss';

type Activity = ResponseOf<'presale.detail'>;

/**
 * 预售商品 (`presale { id }`, pages.md §2.5): the activity's pictures, the presale price, the
 * countdown to its real start or end, when it ships (付款后 N 天内发货), and 立即预订 (the SKU
 * sheet → 确认订单 with `kind: 'presale'`).
 *
 * Full payment only: the backend has no deposit / balance presale
 * (`PRESALE_DEPOSIT_NOT_SUPPORTED`), so the whole price is paid at checkout and the page says so.
 * Browsing needs no session (it is shared to the timeline); 立即预订 goes through `requireLogin`.
 */
export default function PresaleDetailPage() {
  const { id = '' } = useRouteParams('presale');
  const detail = useRouteQuery('presale.detail', { params: { id } }, { enabled: id !== '' });
  useRefetchOnShow(routeKey('presale.detail'));
  const activity = detail.data;
  useShare(id ? { route: 'presale', params: { id } } : null, {
    title: activity ? `预售 ¥${activity.price} ${activity.title}` : undefined,
    imageUrl: assetUrl(activity?.imageUrl) ?? undefined,
  });

  if (id === '') {
    return (
      <PageShell title="预售商品">
        <Empty title="没有指定预售活动" />
      </PageShell>
    );
  }
  if (detail.isPending) {
    return (
      <PageShell title="预售商品">
        <ActivitySkeleton />
      </PageShell>
    );
  }
  if (detail.isError) {
    if (isApiError(detail.error) && detail.error.code === 'PRESALE_ACTIVITY_NOT_FOUND') {
      return (
        <PageShell title="预售商品">
          <View className="presale-detail__gone" id="presale-gone">
            <Empty
              image="search"
              title="预售活动已结束"
              description="这个预售活动已经结束或下架了"
              actions={
                <Button onClick={() => navigate({ route: 'presaleList', params: {} })}>
                  看看其他预售
                </Button>
              }
            />
          </View>
        </PageShell>
      );
    }
    return (
      <PageShell title="预售商品">
        <ErrorBlock error={detail.error} onRetry={() => detail.refetch()} />
      </PageShell>
    );
  }
  return <Detail activity={detail.data} onStale={() => detail.refetch()} />;
}

function Detail({ activity, onStale }: { activity: Activity; onStale: () => void }) {
  const route = { route: 'presale' as const, params: { id: activity.activityId } };
  const [sheet, setSheet] = useState<'sku' | 'share' | null>(null);
  const phase = activityPhase(activity, serverNow());
  const deadline = activityDeadline(activity, phase);

  const start = async () => {
    if (!(await requireLogin(route))) return;
    setSheet('sku');
  };

  return (
    <PageShell title="预售商品" withBar>
      <ActivityHero
        title={activity.title}
        intro={activity.intro}
        imageUrl={activity.imageUrl}
        sliderImages={activity.sliderImages}
        price={activity.price}
        originalPrice={activity.originalPrice}
        badge="预售"
        sales={salesText('已售', activity.sales)}
        deadline={deadline}
        onDeadline={onStale}
        onShare={() => setSheet('share')}
        overlay={phase === 'on' || phase === 'upcoming' ? undefined : PHASE_BUTTON[phase]}
      />

      <ActivityNotes
        title="预售说明"
        id="presale-rules"
        lines={[
          `全款预订，${shipText(activity.shipAfterDays)}`,
          '下单时支付全部货款，无需另付尾款',
          `每单限购 ${activity.perOrderQuantity} 件`,
        ]}
      />

      <ActivityDescription html={activity.description} />

      <ActionBar
        icons={[
          {
            icon: 'home',
            label: '首页',
            onClick: () => void navigate({ route: 'home', params: {} }),
          },
        ]}
      >
        <Button
          variant="secondary"
          block
          // Back to 商品详情 when this activity was opened from its banner, not a second copy.
          onClick={() => leaveFor({ route: 'product', params: { id: activity.productId } })}
        >
          查看商品
        </Button>
        {phase === 'on' ? (
          <Button block onClick={() => start()}>
            立即预订
          </Button>
        ) : (
          <Button block disabled>
            {PHASE_BUTTON[phase]}
          </Button>
        )}
      </ActionBar>

      <ActivitySkuSheet
        visible={sheet === 'sku'}
        onClose={() => setSheet(null)}
        title={activity.title}
        imageUrl={activity.imageUrl}
        skus={activity.skus}
        perOrderQuantity={activity.perOrderQuantity}
        confirmText="立即预订"
        onConfirm={(sku, quantity) => {
          setSheet(null);
          return startActivityCheckout({
            kind: 'presale',
            activityId: activity.activityId,
            skuId: sku.skuId,
            quantity,
          });
        }}
      />
      <ShareSheet visible={sheet === 'share'} onClose={() => setSheet(null)} />
    </PageShell>
  );
}
