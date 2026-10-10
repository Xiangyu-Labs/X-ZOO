import { useEffect, useMemo, useRef } from 'react';
import { View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useTabPage } from '@/app-shell/tab-page';
import { useAppConfig } from '@/app-config';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { useRecordVisit } from '@/data/visits';
import { DecorPage } from '@/features/decor/decor-page';
import { DecorSkeleton } from '@/features/decor/decor-states';
import { SplashOverlay } from '@/features/decor/splash-overlay';
import { assetUrl } from '@/lib/asset-url';
import { navigate, usePullToRefresh, useShare } from '@/platform';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { NavBar, NavBarLead } from '@/ui/nav-bar';
import { PageShell } from '@/ui/page-shell';
import { SearchBar } from '@/ui/search-bar';
import './index.scss';

/**
 * 首页 (tab `home`, custom navigation bar): the shop's designated DIY home page
 * (`GET /pages/home`) under its own bar, the 开屏浮层, pull to refresh, sharing to friends and the
 * timeline.
 *
 * The bar follows the page's 顶部导航栏 setting (root props): its colour, and the logo uploaded
 * there (`navStyle: 'logo'`) or else the title. The shop's 方形 Logo is not used here. Beside it:
 *
 * - the page's 搜索框 block, when that block is set 放进顶栏 (`inNavBar`); it then leaves the
 *   block list, so there is one search entry;
 * - nothing, when the page has a 搜索框 block of its own further down;
 * - the built-in search entry, when the page has none.
 *
 * The resolved page carries per-shopper state (`personal`, e.g. which coupons are claimed), so
 * it is fetched again when the shopper signs in or out.
 */
export default function Home() {
  useTabPage('home');
  useRecordVisit('home');
  const config = useAppConfig();
  const signedIn = useSignedIn();
  const home = useRouteQuery('decor.pageHome');
  const root = home.data?.root.props;
  // The page's own 搜索框 block is the search entry: in the bar when it asks to be, else further
  // down, and the bar then only says where you are.
  const searchBlock = home.data?.blocks.find((block) => block.type === 'searchBar');
  const navSearch = searchBlock?.props.inNavBar === true ? searchBlock : null;
  const page = useMemo(
    () =>
      home.data && navSearch
        ? { ...home.data, blocks: home.data.blocks.filter((block) => block !== navSearch) }
        : home.data,
    [home.data, navSearch],
  );

  const lastSignedIn = useRef(signedIn);
  const { refetch } = home;
  useEffect(() => {
    if (lastSignedIn.current === signedIn) return;
    lastSignedIn.current = signedIn;
    void refetch();
  }, [signedIn, refetch]);

  // A claim made on another page marks it stale: its 优惠券 block says 已领取 once back here.
  useRefetchOnShow(routeKey('decor.pageHome'), { when: 'invalidated' });
  usePullToRefresh(() => home.refetch());
  // The page's own title, unless it is the generic 「首页」 every new page starts with: a friend
  // sent a card titled 首页 learns nothing, so the shop's name stands in.
  const ownTitle = root?.title?.trim() && root.title.trim() !== '首页' ? root.title.trim() : null;
  const shopName = config?.name?.trim() || null;
  useShare(
    { route: 'home', params: {} },
    {
      title: root?.shareTitle || ownTitle || config?.share.title || shopName || undefined,
      imageUrl: assetUrl(root?.shareImage) ?? undefined,
    },
  );

  const title = ownTitle ?? shopName ?? '首页';
  const logo = root?.navStyle === 'logo' ? (root.navLogo ?? null) : null;
  const placeholder = navSearch?.props.placeholder;
  const openSearch = () => navigate({ route: 'search', params: {} });
  return (
    <PageShell title={title}>
      <NavBar background={root?.navBackground}>
        {navSearch ? (
          <>
            <NavBarLead logo={logo} title={title} beside />
            <SearchBar
              className="home__search"
              placeholder={typeof placeholder === 'string' && placeholder ? placeholder : undefined}
              onOpen={openSearch}
            />
          </>
        ) : searchBlock ? (
          <NavBarLead logo={logo} title={title} />
        ) : (
          <>
            {logo ? <NavBarLead logo={logo} title={title} beside /> : null}
            <SearchBar className="home__search" onOpen={openSearch} />
          </>
        )}
      </NavBar>
      <Body query={home} page={page} />
      <SplashOverlay />
    </PageShell>
  );
}

function Body({
  query,
  page,
}: {
  query: ReturnType<typeof useRouteQuery<'decor.pageHome'>>;
  /** The page as `DecorPage` draws it: without the 搜索框 block the bar has taken. */
  page: ReturnType<typeof useRouteQuery<'decor.pageHome'>>['data'];
}) {
  if (query.isPending) return <DecorSkeleton />;
  if (query.isError) {
    if (isApiError(query.error) && query.error.code === 'DECOR_HOME_NOT_SET') {
      return (
        <View className="home__empty" id="home-not-set">
          <Empty
            title="店铺首页正在布置"
            description="先去看看全部商品吧"
            actions={
              <Button variant="outline" onClick={() => navigate({ route: 'category', params: {} })}>
                去逛逛
              </Button>
            }
          />
        </View>
      );
    }
    return <ErrorBlock error={query.error} onRetry={() => query.refetch()} />;
  }
  return (
    <DecorPage
      page={page ?? query.data}
      route={{ route: 'home', params: {} }}
      reload={() => query.refetch()}
    />
  );
}
