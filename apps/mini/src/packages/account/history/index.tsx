import { Text, View } from '@tarojs/components';
import { flattenPages, useInfiniteRouteQuery, useRouteMutation } from '@shop/api-client/react';
import { formatDate } from '@/lib/format';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { confirm, toast } from '@/ui/feedback';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { errorMessage } from '../shared/form';
import { ManageBar, ProductRow, useSelection } from '../shared/manage';
import './index.scss';

/**
 * 浏览记录 (`history`, pages.md §2.6): grouped by day, newest first. 管理 deletes the ticked
 * rows; 清空 deletes all of it, after a confirmation.
 */
export default function HistoryPage() {
  const signedIn = useSignedIn();
  return (
    <PageShell title="浏览记录" withBar={signedIn}>
      <LoginGate reason="登录后可以查看浏览记录" redirect={{ route: 'history', params: {} }}>
        <History />
      </LoginGate>
    </PageShell>
  );
}

function History() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'catalog.historyList',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  const invalidate = { invalidate: ['catalog.historyList'] } as const;
  const remove = useRouteMutation('catalog.historyRemove', invalidate);
  const clearAll = useRouteMutation('catalog.historyClear', invalidate);
  const selection = useSelection();
  const items = flattenPages(list.data);
  const all = items.map((item) => item.product.id);

  async function removeRows(productIds: string[]) {
    try {
      await remove.mutateAsync({ body: { productIds } });
      selection.clear();
      toast.success('已删除');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  async function clear() {
    const ok = await confirm({
      title: '清空浏览记录',
      content: '清空后无法恢复。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await clearAll.mutateAsync();
      if (selection.managing) selection.toggleManaging();
      toast.success('已清空');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      {all.length > 0 ? (
        <View className="manage-head">
          <Button variant="text" size="sm" onClick={() => clear()}>
            清空
          </Button>
          <Button variant="text" size="sm" onClick={selection.toggleManaging}>
            {selection.managing ? '完成' : '管理'}
          </Button>
        </View>
      ) : null}
      <InfiniteList
        query={list}
        itemKey={(item) => item.product.id}
        skeleton={<CellSkeleton rows={4} />}
        empty={<Empty title="还没有浏览记录" description="看过的商品会记在这里" />}
        renderItem={(item, index) => {
          const day = formatDate(item.viewedAt);
          const previous = items[index - 1];
          const first = !previous || formatDate(previous.viewedAt) !== day;
          return (
            <>
              {first ? <Text className="history__day">{day}</Text> : null}
              <ProductRow
                product={item.product}
                unavailable={!item.available}
                selection={selection}
              />
            </>
          );
        }}
      />
      {selection.managing ? (
        <ManageBar
          selection={selection}
          all={all}
          action="删除"
          busy={remove.isPending}
          onAction={(ids) => removeRows(ids)}
        />
      ) : null}
    </View>
  );
}
