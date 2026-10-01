import { useEffect, useRef } from 'react';
import { Text, View } from '@tarojs/components';
import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useTabPage } from '@/app-shell/tab-page';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { DecorPage } from '@/features/decor/decor-page';
import { DecorSkeleton } from '@/features/decor/decor-states';
import { navigate, usePullToRefresh } from '@/platform';
import { useSignedIn } from '@/session/session';
import { ErrorBlock } from '@/ui/error-block';
import { Icon } from '@/ui/icon';
import { NavBar } from '@/ui/nav-bar';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import './index.scss';

const ROUTE = { route: 'me', params: {} } as const;

/**
 * 我的 (tab `me`, custom navigation bar, pages.md §2.1): the 个人中心 the operator decorated
 * (`decor.pageUserCenter`, the built-in one when none is), drawn by the decor renderer. A guest sees the same page with
 * 「登录/注册」 in the user card. Refetched when the shopper signs in or out, on every show
 * (order counts move; not only once stale) and on pull-down.
 */
export default function Me() {
  useTabPage('me');
  const signedIn = useSignedIn();
  const page = useRouteQuery('decor.pageUserCenter', {});
  const unread = useRouteQuery('notification.myUnreadCount', {}, { enabled: signedIn });
  // Every show, fresh or not: the counts on this page move with a payment, a receipt, a
  // refund, a review or a claim made on another page, and the server's own changes (shipped).
  useRefetchOnShow(routeKey('decor.pageUserCenter'), { when: 'always' });
  useRefetchOnShow(routeKey('notification.myUnreadCount'), { when: 'always' });
  usePullToRefresh(() => Promise.all([page.refetch(), signedIn ? unread.refetch() : null]));

  // Signing in does not clear the cache (signing out does): the guest's page must go.
  const wasSignedIn = useRef(signedIn);
  const { refetch } = page;
  useEffect(() => {
    if (wasSignedIn.current === signedIn) return;
    wasSignedIn.current = signedIn;
    void refetch();
  }, [signedIn, refetch]);

  const unreadCount = signedIn ? (unread.data?.unread ?? 0) : 0;
  const background = page.data?.root.props.background;

  return (
    <PageShell title="我的">
      <NavBar title="我的" />
      <View className="me" {...(background ? { style: { background } } : {})}>
        {page.isPending ? (
          <DecorSkeleton />
        ) : page.isError ? (
          <ErrorBlock error={page.error} onRetry={() => page.refetch()} />
        ) : (
          <DecorPage page={page.data} route={ROUTE} reload={() => page.refetch()} />
        )}
        {unreadCount > 0 ? (
          <Pressable
            label={`${unreadCount} 条未读消息`}
            role="link"
            className="me__unread"
            onClick={() => navigate({ route: 'messages', params: {} })}
          >
            <Icon name="bell" />
            <Text className="me__unread-text">{unreadCount} 条未读消息</Text>
            <Icon name="chevron-right" className="me__unread-arrow" />
          </Pressable>
        ) : null}
      </View>
    </PageShell>
  );
}
