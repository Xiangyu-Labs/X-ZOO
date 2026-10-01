import { Text, View } from '@tarojs/components';
import { useRouteQuery } from '@shop/api-client/react';
import { RichContent } from '@/features/content/rich-content';
import { formatDate } from '@/lib/format';
import { openPrivacyContract, useRouteParams } from '@/platform';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import './index.scss';

type AgreementKey = 'user' | 'privacy' | 'cancellation';

/** Each key's title until the operator's own arrives (and when it never was filled in). */
export const AGREEMENT_TITLES: Readonly<Record<AgreementKey, string>> = {
  user: '用户协议',
  privacy: '隐私政策',
  cancellation: '注销协议',
};

function agreementKey(value: string | undefined): AgreementKey {
  return value === 'privacy' || value === 'cancellation' ? value : 'user';
}

/**
 * 用户协议 / 隐私政策 / 注销协议 (`agreement { key }`, pages.md §2.1): one page for the three,
 * titled by the key. In the main package so the login page and the privacy sheet open it
 * without waiting for a sub-package. 隐私政策 also offers WeChat's own 隐私保护指引 (C04).
 */
export default function AgreementPage() {
  const key = agreementKey(useRouteParams('agreement').key);
  const query = useRouteQuery('system.agreementGet', { params: { key } });
  const title = query.data?.title || AGREEMENT_TITLES[key];

  return (
    <PageShell title={title} bg="surface">
      <View className="agreement">
        {query.isPending ? (
          <CellSkeleton rows={6} />
        ) : query.isError ? (
          <ErrorBlock error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <>
            <Text className="agreement__title">{title}</Text>
            {query.data.updatedAt ? (
              <Text className="agreement__date">更新于 {formatDate(query.data.updatedAt)}</Text>
            ) : null}
            {query.data.content.trim() ? (
              <View className="agreement__body">
                <RichContent html={query.data.content} />
              </View>
            ) : (
              <Empty compact title="内容整理中" description="商家还没有发布这份内容" />
            )}
          </>
        )}
        {key === 'privacy' ? (
          <View className="agreement__extra">
            <Button variant="outline" block onClick={openPrivacyContract}>
              查看《小程序隐私保护指引》
            </Button>
          </View>
        ) : null}
      </View>
    </PageShell>
  );
}
