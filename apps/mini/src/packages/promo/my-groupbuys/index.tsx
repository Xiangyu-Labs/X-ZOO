import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { routeKey, useInfiniteRouteQuery } from '@shop/api-client/react';
import { LIST_FULL_RELOAD_AFTER_MS, useRefetchOnShow } from '@/data/use-refetch-on-show';
import { myTeamStatus, type MyTeam } from '@/features/groupbuy/team';
import { serverNow } from '@/lib/server-clock';
import { navigate } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Empty } from '@/ui/empty';
import { Image } from '@/ui/image';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import { Tag } from '@/ui/tag';
import './index.scss';

type Tab = 'all' | 'forming' | 'succeeded' | 'failed';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'forming', label: '拼团中' },
  { key: 'succeeded', label: '已成团' },
  { key: 'failed', label: '未成团' },
];

const TONE = { primary: 'primary', success: 'success', default: 'neutral' } as const;

/**
 * 我的拼团 (`myGroupbuys`, pages.md §2.5): 全部 / 拼团中 / 已成团 / 未成团, newest first. A card
 * opens its team page; 查看订单 opens the order. An unfilled team says whether the refund is on
 * its way or back (虚拟成团 is off: every unfilled team fails and refunds).
 */
export default function MyGroupbuysPage() {
  const [tab, setTab] = useState<Tab>('all');
  return (
    <PageShell title="我的拼团">
      <LoginCard reason="登录后查看你的拼团" redirect={{ route: 'myGroupbuys', params: {} }}>
        <Tabs items={TABS} value={tab} onChange={setTab} sticky />
        <Teams key={tab} tab={tab} />
      </LoginCard>
    </PageShell>
  );
}

function Teams({ tab }: { tab: Tab }) {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'groupbuy.myGroups',
    { query: { pageSize: 20, ...(tab === 'all' ? {} : { status: tab }) } },
    { enabled: signedIn },
  );
  // Teams fill, succeed or run out of time while the shopper is elsewhere.
  useRefetchOnShow(routeKey('groupbuy.myGroups'), {
    pages: 'first',
    allPagesAfter: LIST_FULL_RELOAD_AFTER_MS,
  });
  return (
    <View className="my-groupbuys" id={`my-groupbuys-${tab}`}>
      <InfiniteList
        query={list}
        itemKey={(item) => item.groupId}
        className="my-groupbuys__list"
        renderItem={(item) => <TeamCard item={item} />}
        skeleton={<CellSkeleton rows={3} />}
        empty={
          <Empty
            image="order"
            title={tab === 'all' ? '还没有参加过拼团' : '这里还没有拼团'}
            actions={
              <Button
                variant="outline"
                onClick={() => navigate({ route: 'groupbuyList', params: {} })}
              >
                去看看拼团
              </Button>
            }
          />
        }
      />
    </View>
  );
}

function TeamCard({ item }: { item: MyTeam }) {
  const status = myTeamStatus(item, serverNow());
  const team = { route: 'groupbuyTeam', params: { id: item.groupId } } as const;
  return (
    <Card className="my-groupbuys__card" id={`my-team-${item.groupId}`}>
      <Pressable
        label={`${item.title}，${status.text}`}
        role="link"
        className="my-groupbuys__main"
        onClick={() => navigate(team)}
      >
        <View className="my-groupbuys__image">
          <Image src={item.imageUrl} label={item.title} radius="sm" lazy size="small" />
        </View>
        <View className="my-groupbuys__body">
          <Text className="my-groupbuys__title">{item.title}</Text>
          <Text className="my-groupbuys__meta">
            {item.seatsTotal} 人团 · {item.role === 'leader' ? '我是团长' : '我参与的'}
          </Text>
          <View>
            <Tag tone={TONE[status.tone]}>{status.text}</Tag>
          </View>
        </View>
      </Pressable>
      <View className="my-groupbuys__actions">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ route: 'order', params: { id: item.orderId } })}
        >
          查看订单
        </Button>
        <Button variant="outline-primary" size="sm" onClick={() => navigate(team)}>
          {item.status === 'forming' ? '查看进度' : '拼团详情'}
        </Button>
      </View>
    </Card>
  );
}
