import { useEffect, useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';
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
  ttlText,
} from '@/features/promo/activity';
import { startActivityCheckout } from '@/features/promo/checkout';
import { ShareSheet } from '@/features/share/share-sheet';
import { assetUrl } from '@/lib/asset-url';
import { serverNow } from '@/lib/server-clock';
import { leaveFor, navigate, useRouteParams, useShare } from '@/platform';
import { requireLogin, useSignedIn } from '@/session/session';
import { ActionBar } from '@/ui/action-bar';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Cell } from '@/ui/cell';
import { Countdown } from '@/ui/countdown';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { PageShell } from '@/ui/page-shell';
import './index.scss';

type Activity = ResponseOf<'groupbuy.detail'>;

/**
 * 拼团商品 (`groupbuy { id }`, pages.md §2.5): the activity's pictures and price, the countdown
 * to its real start or end, the rules (人满成团; an unfilled team is cancelled and refunded:
 * 虚拟成团 is off), the teams still open (→ their team page), and the action bar: 单独购买
 * (the product page) and 发起拼团 (the SKU sheet → 确认订单 with `kind: 'groupbuy'`).
 *
 * Browsing needs no session (it is shared to the timeline); 发起拼团 goes through
 * `requireLogin`. A leader whose team on this activity is still open is sent to it instead.
 */
export default function GroupbuyDetailPage() {
  const { id = '' } = useRouteParams('groupbuy');
  const detail = useRouteQuery('groupbuy.detail', { params: { id } }, { enabled: id !== '' });
  // Back from 确认订单 / 收银台 / an order: whether the shopper now leads a team here.
  useRefetchOnShow(routeKey('groupbuy.detail'));
  // Read before the session (a shared link opened while the silent login ran, or signed in from
  // 发起拼团): `myOpenGroupId` is null until read again, and a leader would open a second team.
  const signedIn = useSignedIn();
  const lastSignedIn = useRef(signedIn);
  const { refetch } = detail;
  useEffect(() => {
    if (lastSignedIn.current === signedIn) return;
    lastSignedIn.current = signedIn;
    void refetch();
  }, [signedIn, refetch]);
  const activity = detail.data;
  useShare(id ? { route: 'groupbuy', params: { id } } : null, {
    title: activity
      ? `${activity.seatsRequired}人团 ¥${activity.price} ${activity.title}`
      : undefined,
    imageUrl: assetUrl(activity?.imageUrl) ?? undefined,
  });

  if (id === '') {
    return (
      <PageShell title="拼团商品">
        <Empty title="没有指定拼团活动" />
      </PageShell>
    );
  }
  if (detail.isPending) {
    return (
      <PageShell title="拼团商品">
        <ActivitySkeleton />
      </PageShell>
    );
  }
  if (detail.isError) {
    if (isApiError(detail.error) && detail.error.code === 'GROUPBUY_ACTIVITY_NOT_FOUND') {
      return (
        <PageShell title="拼团商品">
          <View className="groupbuy-detail__gone" id="groupbuy-gone">
            <Empty
              image="search"
              title="拼团活动已结束"
              description="这个拼团活动已经结束或下架了"
              actions={
                <Button onClick={() => navigate({ route: 'groupbuyList', params: {} })}>
                  看看其他拼团
                </Button>
              }
            />
          </View>
        </PageShell>
      );
    }
    return (
      <PageShell title="拼团商品">
        <ErrorBlock error={detail.error} onRetry={() => detail.refetch()} />
      </PageShell>
    );
  }
  return <Detail activity={detail.data} onStale={() => detail.refetch()} />;
}

function Detail({ activity, onStale }: { activity: Activity; onStale: () => void }) {
  const route = { route: 'groupbuy' as const, params: { id: activity.activityId } };
  const [sheet, setSheet] = useState<'sku' | 'share' | null>(null);
  const phase = activityPhase(activity, serverNow());
  const deadline = activityDeadline(activity, phase);
  const myTeam = activity.myOpenGroupId;
  // The shopper's open team may be one they joined, not one they started (L8).
  const joined = activity.myOpenGroupRole === 'member';
  const openTeam = (groupId: string) =>
    navigate({ route: 'groupbuyTeam', params: { id: groupId } });

  const start = async () => {
    if (!(await requireLogin(route))) return;
    setSheet('sku');
  };

  return (
    <PageShell title="拼团商品" withBar>
      <ActivityHero
        title={activity.title}
        intro={activity.intro}
        imageUrl={activity.imageUrl}
        sliderImages={activity.sliderImages}
        price={activity.price}
        originalPrice={activity.originalPrice}
        badge={`${activity.seatsRequired}人团`}
        sales={salesText('已拼', activity.sales)}
        deadline={deadline}
        onDeadline={onStale}
        onShare={() => setSheet('share')}
        overlay={phase === 'on' || phase === 'upcoming' ? undefined : PHASE_BUTTON[phase]}
      />

      {myTeam ? (
        <View className="groupbuy-detail__mine">
          <Cell
            title={joined ? '你参加的团正在拼' : '你发起的团正在拼'}
            label={joined ? '查看我参加的团' : '查看我发起的团'}
            value="查看进度"
            icon="group"
            onClick={() => openTeam(myTeam)}
          />
        </View>
      ) : null}

      <ActivityNotes
        title="拼团规则"
        id="groupbuy-rules"
        lines={[
          `${activity.seatsRequired} 人成团，开团后 ${ttlText(activity.groupTtlSeconds)}内有效`,
          '付款后即占一个名额，人满即成团，商家随后发货',
          '到时间未凑齐，拼团自动取消，已付款项原路退回',
          `每单限购 ${activity.perOrderQuantity} 件`,
        ]}
      />

      {phase === 'on' ? (
        <OpenTeams activityId={activity.activityId} exclude={myTeam} onOpen={openTeam} />
      ) : null}

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
          单独购买
        </Button>
        {phase !== 'on' ? (
          <Button block disabled>
            {PHASE_BUTTON[phase]}
          </Button>
        ) : myTeam ? (
          <Button block onClick={() => openTeam(myTeam)}>
            查看我的团
          </Button>
        ) : (
          <Button block onClick={() => start()}>
            发起拼团
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
        confirmText="发起拼团"
        onConfirm={(sku, quantity) => {
          setSheet(null);
          return startActivityCheckout({
            kind: 'groupbuy',
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

/**
 * Teams on this activity still looking for members. Only the seats and the time left are shown:
 * a stranger's name and face have no place on a public page of this shop. 去参团 opens the
 * team page, which asks for the SKU there.
 */
function OpenTeams({
  activityId,
  exclude,
  onOpen,
}: {
  activityId: string;
  exclude: string | null;
  onOpen: (groupId: string) => void;
}) {
  const teams = useRouteQuery('groupbuy.openGroups', {
    params: { id: activityId },
    query: { pageSize: 5 },
  });
  const items = (teams.data?.items ?? []).filter((team) => team.groupId !== exclude);
  if (items.length === 0) return null;
  return (
    <Card title="正在拼的团" className="groupbuy-detail__teams" id="groupbuy-open-teams">
      <Text className="groupbuy-detail__teams-note">可直接参与，人满即成团</Text>
      {items.map((team) => (
        <View key={team.groupId} className="groupbuy-detail__team">
          <View className="groupbuy-detail__team-body">
            <Text className="groupbuy-detail__team-seats">还差 {team.seatsLeft} 人成团</Text>
            <View className="groupbuy-detail__team-time">
              <Text className="groupbuy-detail__team-label">剩余</Text>
              <Countdown endsAt={team.expiresAt} onEnd={() => teams.refetch()} />
            </View>
          </View>
          <Button
            size="sm"
            variant="outline-primary"
            label={`去参团，还差 ${team.seatsLeft} 人`}
            onClick={() => onOpen(team.groupId)}
          >
            去参团
          </Button>
        </View>
      ))}
    </Card>
  );
}
