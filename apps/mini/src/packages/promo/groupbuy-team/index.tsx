import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { routeQueryKey, useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import {
  inviteTitle,
  seatsOf,
  teamActions,
  teamHeadline,
  teamPhase,
  type TeamAction,
  type TeamView,
} from '@/features/groupbuy/team';
import { ActivitySkuSheet } from '@/features/promo/activity-sku-sheet';
import { startActivityCheckout } from '@/features/promo/checkout';
import { PosterSheet } from '@/features/share/poster-sheet';
import { ShareSheet } from '@/features/share/share-sheet';
import { COUPON_READS, DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { strikePrice } from '@/lib/money';
import { serverNow } from '@/lib/server-clock';
import { leaveFor, navigate, usePullToRefresh, useRouteParams, useShare } from '@/platform';
import { requireLogin, useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Countdown } from '@/ui/countdown';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { confirm, toast } from '@/ui/feedback';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import './index.scss';

/**
 * 拼团进度 (`groupbuyTeam { id }`, pages.md §2.5): one team, from the viewer's side. The
 * headline says where it stands (还差 N 人 / 拼团成功 / 未成团 and whether the money is back),
 * the seats show how many are taken, the countdown runs to the team's real deadline on the
 * server's clock and reads the team again when it ends.
 *
 * What the viewer can do follows `teamActions`: a stranger joins (login → the activity's SKU
 * sheet → 确认订单 with `kindMeta.groupId`), a member who has not paid pays, a leader nobody has
 * paid into may withdraw, a paid member invites (WeChat share or a poster), and a closed team
 * offers its order and 再开一团.
 *
 * Members are shown as taken seats (团长 / 已参团), never by name or face: the page is shared,
 * and who bought what in this shop is nobody else's business.
 */
export default function GroupbuyTeamPage() {
  const { id = '' } = useRouteParams('groupbuyTeam');
  const team = useRouteQuery('groupbuy.groupDetail', { params: { id } }, { enabled: id !== '' });
  // Back from the share sheet, 收银台 or a friend's chat: seats fill and teams close meanwhile.
  useRefetchOnShow(routeQueryKey('groupbuy.groupDetail', { params: { id } }), { when: 'always' });
  // Read before the session (a shared link opened while the silent login ran, or signed in from
  // 参与拼团): `me` is null until read again, and a member would be offered 参与拼团 in their own
  // team instead of 邀请好友.
  const signedIn = useSignedIn();
  const lastSignedIn = useRef(signedIn);
  const { refetch } = team;
  useEffect(() => {
    if (lastSignedIn.current === signedIn) return;
    lastSignedIn.current = signedIn;
    void refetch();
  }, [signedIn, refetch]);
  usePullToRefresh(() => team.refetch());
  const view = team.data;
  useShare(id ? { route: 'groupbuyTeam', params: { id } } : null, {
    title: view ? inviteTitle(view) : undefined,
    imageUrl: assetUrl(view?.imageUrl) ?? undefined,
  });

  if (id === '') {
    return (
      <PageShell title="拼团进度">
        <Empty title="没有指定拼团" />
      </PageShell>
    );
  }
  if (team.isPending) {
    return (
      <PageShell title="拼团进度">
        <CellSkeleton rows={4} />
      </PageShell>
    );
  }
  if (team.isError) {
    if (isApiError(team.error) && team.error.code === 'GROUPBUY_GROUP_NOT_FOUND') {
      return (
        <PageShell title="拼团进度">
          <View className="groupbuy-team__gone" id="groupbuy-team-gone">
            <Empty
              image="search"
              title="这个团不存在"
              description="它可能已经被取消了"
              actions={
                <Button onClick={() => navigate({ route: 'groupbuyList', params: {} })}>
                  去看看拼团
                </Button>
              }
            />
          </View>
        </PageShell>
      );
    }
    return (
      <PageShell title="拼团进度">
        <ErrorBlock error={team.error} onRetry={() => team.refetch()} />
      </PageShell>
    );
  }
  return <Team view={team.data} onStale={() => team.refetch()} />;
}

const ACTION_TEXT: Record<TeamAction['kind'], string> = {
  join: '参与拼团',
  pay: '去支付',
  withdraw: '取消拼团',
  invite: '邀请好友参团',
  poster: '生成海报',
  order: '查看订单',
  again: '再开一团',
  refresh: '刷新结果',
};

function Team({ view, onStale }: { view: TeamView; onStale: () => void }) {
  const route = { route: 'groupbuyTeam' as const, params: { id: view.groupId } };
  const [sheet, setSheet] = useState<'sku' | 'share' | 'poster' | null>(null);
  const phase = teamPhase(view, serverNow());
  const headline = teamHeadline(view, phase);
  const actions = teamActions(view, phase);
  const activity = useRouteQuery(
    'groupbuy.detail',
    { params: { id: view.activityId } },
    { staleTime: 60_000 },
  );
  const queryClient = useQueryClient();
  // The server cancels the team's unpaid orders: 我的订单 and the counts lose them, and their
  // coupons are back in the wallet (`CANCEL_READS` in the order package says the same).
  const withdraw = useRouteMutation('groupbuy.withdraw', {
    invalidate: [
      'groupbuy.groupDetail',
      'groupbuy.myGroups',
      'groupbuy.detail',
      'order.list',
      'order.counts',
      'order.detail',
      ...COUPON_READS,
    ],
    onSuccess: () => markStale(queryClient, ...DECOR_PAGE_READS),
  });

  const run = async (action: TeamAction) => {
    switch (action.kind) {
      case 'join':
        if (!(await requireLogin(route))) return;
        setSheet('sku');
        return;
      case 'pay':
        await navigate({ route: 'cashier', params: { orderId: action.orderId } });
        return;
      case 'withdraw': {
        const ok = await confirm({
          title: '取消这个团？',
          content: '还没有人付款，取消后这个团就关闭了。',
          confirmText: '取消拼团',
          cancelText: '再想想',
          danger: true,
        });
        if (!ok) return;
        await withdraw.mutateAsync({ params: { id: view.groupId }, body: {} }).then(
          () => toast.success('已取消拼团'),
          (error: unknown) =>
            toast.text(
              isApiError(error) && error.code === 'GROUPBUY_GROUP_NOT_WITHDRAWABLE'
                ? '已有好友付款，不能取消了'
                : '取消失败，请稍后重试',
            ),
        );
        return;
      }
      case 'invite':
        setSheet('share');
        return;
      case 'poster':
        setSheet('poster');
        return;
      // These leave the team for a page it was usually opened from (订单详情's 拼团进度, the
      // activity's 查看团): back to that page rather than a second copy of it on the stack.
      case 'order':
        await leaveFor({ route: 'order', params: { id: action.orderId } });
        return;
      case 'again':
        await leaveFor({ route: 'groupbuy', params: { id: view.activityId } });
        return;
      case 'refresh':
        onStale();
        return;
    }
  };

  const seatsTaken = view.seatsTotal - view.seatsLeft;
  const strike = strikePrice(view.price, activity.data?.originalPrice);
  const badge = `${view.seatsTotal} 人团${view.seatsLeft > 0 ? ` · 还差 ${view.seatsLeft} 人成团` : ''}`;

  return (
    <PageShell title="拼团进度">
      <View className="groupbuy-team" id="groupbuy-team">
        <Card className="groupbuy-team__product">
          <Pressable
            role="link"
            label={`${view.title}，查看拼团商品`}
            className="groupbuy-team__product-row"
            onClick={() => leaveFor({ route: 'groupbuy', params: { id: view.activityId } })}
          >
            <View className="groupbuy-team__image">
              <Image src={view.imageUrl} label={view.title} radius="sm" lazy={false} size="small" />
            </View>
            <View className="groupbuy-team__product-body">
              <Text className="groupbuy-team__title">{view.title}</Text>
              <Text className="groupbuy-team__meta">{view.seatsTotal} 人团</Text>
              <View className="groupbuy-team__price">
                <Price value={view.price} />
                {strike ? <Price value={strike} size="sm" strike /> : null}
              </View>
            </View>
            <Icon name="chevron-right" className="groupbuy-team__chevron" />
          </Pressable>
        </Card>

        <Card className="groupbuy-team__status">
          <Text
            className={cx('groupbuy-team__headline', `groupbuy-team__headline--${headline.tone}`)}
            id="team-headline"
          >
            {headline.title}
          </Text>
          {phase === 'open' ? (
            <View className="groupbuy-team__deadline">
              <Text className="groupbuy-team__deadline-label">剩余</Text>
              <Countdown endsAt={view.expiresAt} variant="boxed" onEnd={onStale} />
            </View>
          ) : null}

          {/* A team that did not fill has nobody left in it: its seats say nothing. */}
          {phase === 'failed' || phase === 'refunded' || phase === 'cancelled' ? null : (
            <View
              className="groupbuy-team__seats"
              ariaLabel={`${view.seatsTotal} 人团，已有 ${seatsTaken} 人`}
            >
              {seatsOf(view).map((member, index) => (
                <View
                  key={index}
                  className={cx('groupbuy-team__seat', !member && 'groupbuy-team__seat--open')}
                  ariaHidden
                >
                  <View className="groupbuy-team__seat-circle">
                    <Icon name={member ? 'user' : 'plus'} />
                  </View>
                  <Text className="groupbuy-team__seat-label">
                    {member ? (member.role === 'leader' ? '团长' : '已参团') : '待加入'}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <Text className="groupbuy-team__note">{headline.note}</Text>

          <View className="groupbuy-team__actions" id="team-actions">
            {actions.map((action, index) => (
              <Button
                key={action.kind}
                block
                size="lg"
                variant={index === 0 ? 'primary' : 'outline'}
                loading={action.kind === 'withdraw' && withdraw.isPending}
                disabled={action.kind === 'join' && !activity.data}
                onClick={() => run(action)}
              >
                {ACTION_TEXT[action.kind]}
              </Button>
            ))}
          </View>
        </Card>

        <Card title="拼团须知" className="groupbuy-team__rules">
          <Text className="groupbuy-team__rule">
            付款后即占一个名额，人满即成团，商家随后发货。
          </Text>
          <Text className="groupbuy-team__rule">
            到时间未凑齐 {view.seatsTotal} 人，拼团自动取消，已付款项原路退回。
          </Text>
        </Card>
      </View>

      {activity.data ? (
        <ActivitySkuSheet
          visible={sheet === 'sku'}
          onClose={() => setSheet(null)}
          title={view.title}
          imageUrl={view.imageUrl}
          skus={activity.data.skus}
          perOrderQuantity={activity.data.perOrderQuantity}
          confirmText="参与拼团"
          onConfirm={(sku, quantity) => {
            setSheet(null);
            return startActivityCheckout({
              kind: 'groupbuy',
              activityId: view.activityId,
              groupId: view.groupId,
              skuId: sku.skuId,
              quantity,
            });
          }}
        />
      ) : null}
      <ShareSheet
        visible={sheet === 'share'}
        onClose={() => setSheet(null)}
        title="邀请好友参团"
        onPoster={() => setSheet('poster')}
      />
      <PosterSheet
        visible={sheet === 'poster'}
        onClose={() => setSheet(null)}
        subject={{
          route: 'groupbuyTeam',
          id: view.groupId,
          title: view.title,
          price: view.price,
          originalPrice: activity.data?.originalPrice ?? null,
          imageUrl: view.imageUrl,
          badge,
        }}
      />
    </PageShell>
  );
}
