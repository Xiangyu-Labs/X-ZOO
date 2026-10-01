import { View } from '@tarojs/components';
import { flattenPages, useInfiniteRouteQuery, useRouteMutation } from '@shop/api-client/react';
import { navigate } from '@/platform';
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

/**
 * 我的收藏 (`favorites`, pages.md §2.6): newest first; 管理 ticks rows for 取消收藏 in one
 * request (`favoriteRemoveBatch`).
 */
export default function FavoritesPage() {
  const signedIn = useSignedIn();
  return (
    <PageShell title="我的收藏" withBar={signedIn}>
      <LoginGate reason="登录后可以查看收藏的商品" redirect={{ route: 'favorites', params: {} }}>
        <Favorites />
      </LoginGate>
    </PageShell>
  );
}

function Favorites() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'catalog.favoriteList',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  const remove = useRouteMutation('catalog.favoriteRemoveBatch', {
    invalidate: ['catalog.favoriteList', 'catalog.productDetail'],
  });
  const selection = useSelection();
  const all = flattenPages(list.data).map((item) => item.product.id);

  async function unfavorite(productIds: string[]) {
    const ok = await confirm({
      title: '取消收藏',
      content: `取消收藏这 ${productIds.length} 件商品？`,
      confirmText: '取消收藏',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync({ body: { productIds } });
      selection.clear();
      toast.success('已取消收藏');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      {all.length > 0 ? (
        <View className="manage-head">
          <View>共 {list.data?.pages[0]?.total ?? all.length} 件</View>
          <Button variant="text" size="sm" onClick={selection.toggleManaging}>
            {selection.managing ? '完成' : '管理'}
          </Button>
        </View>
      ) : null}
      <InfiniteList
        query={list}
        itemKey={(item) => item.product.id}
        skeleton={<CellSkeleton rows={4} />}
        empty={
          <Empty
            title="还没有收藏"
            description="看到喜欢的商品，点「收藏」留着慢慢看"
            actions={
              <Button variant="outline" onClick={() => navigate({ route: 'home', params: {} })}>
                回到首页
              </Button>
            }
          />
        }
        renderItem={(item) => (
          <ProductRow product={item.product} unavailable={!item.available} selection={selection} />
        )}
      />
      {selection.managing ? (
        <ManageBar
          selection={selection}
          all={all}
          action="取消收藏"
          busy={remove.isPending}
          onAction={(ids) => unfavorite(ids)}
        />
      ) : null}
    </View>
  );
}
