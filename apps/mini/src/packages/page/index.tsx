import { useEffect, useRef } from 'react';
import { Text } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { DecorPage } from '@/features/decor/decor-page';
import { DecorSkeleton } from '@/features/decor/decor-states';
import { assetUrl } from '@/lib/asset-url';
import { usePreviewToken, usePullToRefresh, useRouteParams, useShare } from '@/platform';
import { useSignedIn } from '@/session/session';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { PageShell } from '@/ui/page-shell';
import './index.scss';

/**
 * 微页面 (`page { id }`): a published DIY v2 page, on the native navigation bar, rendered by the
 * same `DecorPage` as 首页. The title and the share card are the page's own; a page whose
 * operator switched sharing off shares the home page instead.
 *
 * With `previewToken` (the decor editor's 预览, F2) it shows the document's *draft*, uncached,
 * under a 「草稿预览」 banner; a preview is never shared (the share card is the home page).
 */
export default function MicroPage() {
  const { id = '' } = useRouteParams('page');
  const signedIn = useSignedIn();
  const previewToken = usePreviewToken();
  const page = useRouteQuery(
    'decor.pageResolve',
    { params: { id }, ...(previewToken ? { query: { previewToken } } : {}) },
    { enabled: id !== '', ...(previewToken ? { staleTime: 0, gcTime: 0 } : {}) },
  );
  const root = page.data?.root.props;

  const lastSignedIn = useRef(signedIn);
  const { refetch } = page;
  useEffect(() => {
    if (lastSignedIn.current === signedIn || id === '') return;
    lastSignedIn.current = signedIn;
    void refetch();
  }, [signedIn, refetch, id]);

  // A claim made on another page marks it stale: 已领取 shows once back here.
  useRefetchOnShow(routeKey('decor.pageResolve'), { when: 'invalidated' });
  usePullToRefresh(() => page.refetch());
  const shareable = id !== '' && !previewToken && root?.shareEnabled !== false;
  useShare(
    shareable ? { route: 'page', params: { id } } : null,
    shareable
      ? {
          title: root?.shareTitle || root?.title,
          imageUrl: assetUrl(root?.shareImage) ?? undefined,
        }
      : {},
  );

  const title = root?.title ?? '';
  if (id === '') {
    return (
      <PageShell title="页面">
        <Empty title="没有指定页面" />
      </PageShell>
    );
  }
  return (
    <PageShell title={title}>
      {previewToken ? (
        <Text className="micro-page__preview" id="decor-preview-banner">
          草稿预览：仅供查看效果，发布后顾客才能看到
        </Text>
      ) : null}
      {page.isPending ? (
        <DecorSkeleton />
      ) : page.isError ? (
        isApiError(page.error) && page.error.code === 'DECOR_PREVIEW_TOKEN_INVALID' ? (
          <Empty title="预览已过期" description="请在后台重新打开预览" />
        ) : isApiError(page.error) && page.error.code === 'DECOR_DOCUMENT_NOT_FOUND' ? (
          <Empty title="页面不存在" description="这个页面可能已经下线" />
        ) : (
          <ErrorBlock error={page.error} onRetry={() => page.refetch()} />
        )
      ) : (
        <DecorPage
          page={page.data}
          route={{ route: 'page', params: { id } }}
          reload={() => page.refetch()}
        />
      )}
    </PageShell>
  );
}
