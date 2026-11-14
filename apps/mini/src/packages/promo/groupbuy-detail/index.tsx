import { useEffect, useRef } from 'react';
import { View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { useRouteQuery } from '@shop/api-client/react';
import { ActivitySkeleton } from '@/features/promo/activity-hero';
import { navigate, useRouteParams } from '@/platform';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { PageShell } from '@/ui/page-shell';
import './index.scss';

/**
 * 拼团商品 (`groupbuy { id }`): kept only for links shared before 商品详情 took over 拼团. It
 * reads the activity and replaces itself with its product's page, which shows the 拼团 price,
 * the teams still open, the shopper's own team and 立即开团.
 */
export default function GroupbuyDetailPage() {
  const { id = '' } = useRouteParams('groupbuy');
  const detail = useRouteQuery('groupbuy.detail', { params: { id } }, { enabled: id !== '' });
  const productId = detail.data?.productId;
  const left = useRef(false);
  useEffect(() => {
    if (!productId || left.current) return;
    left.current = true;
    void navigate({ route: 'product', params: { id: productId } }, { replace: true });
  }, [productId]);

  if (id === '') {
    return (
      <PageShell title="拼团商品">
        <Empty title="没有指定拼团活动" />
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
  return (
    <PageShell title="拼团商品">
      <ActivitySkeleton />
    </PageShell>
  );
}
