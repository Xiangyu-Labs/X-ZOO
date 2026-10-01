import { useState } from 'react';
import { View } from '@tarojs/components';
import type { RefundListItem } from '@shop/contracts/refund/schemas';
import { routeKey, useInfiniteRouteQuery } from '@shop/api-client/react';
import { LIST_FULL_RELOAD_AFTER_MS, useRefetchOnShow } from '@/data/use-refetch-on-show';
import { scrollPageToTop, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import { useRefundActions } from '../shared/actions';
import { RefundCard } from '../shared/refund-card';
import './index.scss';

type State = 'all' | 'open' | 'succeeded' | 'closed';

const TABS: ReadonlyArray<{ key: State; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '处理中' },
  { key: 'succeeded', label: '已退款' },
  { key: 'closed', label: '已关闭' },
];

function stateOf(value: string | undefined): State {
  return TABS.find((tab) => tab.key === value)?.key ?? 'all';
}

/**
 * 我的售后 (`refundList`, `packages/aftersale/list/index?state=`). One list for every request,
 * 仅退款 and 退货退款 alike, in the server's four states. It replaces the old app's two lists
 * (退货列表 and 售后列表, which showed the same requests); see docs/mini/pages.md.
 */
export default function RefundListPage() {
  const params = useRouteParams('refundList');
  const [state, setState] = useState<State>(() => stateOf(params.state));
  return (
    <PageShell title="我的售后">
      <LoginCard reason="登录后查看售后" redirect={{ route: 'refundList', params: { state } }}>
        <Tabs
          sticky
          value={state}
          items={TABS}
          onChange={(next) => {
            setState(next);
            scrollPageToTop();
          }}
        />
        <RefundList key={state} state={state} />
      </LoginCard>
    </PageShell>
  );
}

function RefundList({ state }: { state: State }) {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'refund.myList',
    { query: { state, pageSize: 10 } },
    { enabled: signedIn },
  );
  useRefetchOnShow(routeKey('refund.myList'), {
    pages: 'first',
    allPagesAfter: LIST_FULL_RELOAD_AFTER_MS,
  });
  const actions = useRefundActions();
  return (
    <View className="refund-list">
      <InfiniteList<RefundListItem>
        query={list}
        itemKey={(refund) => refund.id}
        renderItem={(refund) => (
          <RefundCard
            refund={refund}
            onAction={(key) => actions.run(key, refund.id)}
            busy={actions.busy?.id === refund.id ? actions.busy.key : undefined}
          />
        )}
        skeleton={
          <>
            <CellSkeleton rows={3} />
            <CellSkeleton rows={3} />
          </>
        }
        empty={<Empty image="order" title="没有售后记录" />}
      />
    </View>
  );
}
