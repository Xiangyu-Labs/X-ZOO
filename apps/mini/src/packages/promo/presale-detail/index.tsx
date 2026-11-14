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
 * 预售商品 (`presale { id }`): kept only for links shared before 商品详情 took over 预售. It
 * reads the activity and replaces itself with its product's page, which shows the 预售 price,
 * when it ships and 立即预订.
 */
export default function PresaleDetailPage() {
  const { id = '' } = useRouteParams('presale');
  const detail = useRouteQuery('presale.detail', { params: { id } }, { enabled: id !== '' });
  const productId = detail.data?.productId;
  const left = useRef(false);
  useEffect(() => {
    if (!productId || left.current) return;
    left.current = true;
    void navigate({ route: 'product', params: { id: productId } }, { replace: true });
  }, [productId]);

  if (id === '') {
    return (
      <PageShell title="预售商品">
        <Empty title="没有指定预售活动" />
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
  return (
    <PageShell title="预售商品">
      <ActivitySkeleton />
    </PageShell>
  );
}
