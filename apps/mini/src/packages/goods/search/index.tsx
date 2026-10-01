import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/error-message';
import { navigate, useRouteParams } from '@/platform';
import { useSignedIn } from '@/session/session';
import { confirm, toast } from '@/ui/feedback';
import { Icon } from '@/ui/icon';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { SearchBar } from '@/ui/search-bar';
import './index.scss';

/**
 * 搜索 (`search { keyword? }`, pages.md §2.2): only 输入 + 热词 + 历史. Submitting replaces this
 * page with 商品列表 { keyword } (`redirectTo`), so 返回 from the results skips the search page.
 * History is the server's (recorded when a signed-in shopper searches), shown only with a
 * session.
 */
export default function Search() {
  const params = useRouteParams('search');
  const signedIn = useSignedIn();
  const [value, setValue] = useState(params.keyword ?? '');
  const hot = useRouteQuery('catalog.hotKeywords', undefined, { staleTime: 10 * 60_000 });
  // Every search adds to it on the server: never show the copy from the last visit first.
  const history = useRouteQuery('catalog.searchHistory', undefined, {
    enabled: signedIn,
    refetchOnMount: 'always',
  });
  const clear = useRouteMutation('catalog.clearSearchHistory', {
    invalidate: ['catalog.searchHistory'],
  });

  const search = (keyword: string) => {
    const text = keyword.trim();
    if (!text) return toast.text('请输入商品名称');
    void navigate({ route: 'productList', params: { keyword: text } }, { replace: true });
  };

  const clearHistory = async () => {
    if (!(await confirm({ content: '清空全部搜索历史？', confirmText: '清空', danger: true })))
      return;
    await clear.mutateAsync(undefined).catch((error: unknown) => toast.text(errorMessage(error)));
  };

  const historyItems = signedIn ? (history.data?.items ?? []) : [];
  const hotItems = hot.data?.items ?? [];

  return (
    <PageShell title="搜索" bg="surface">
      <SearchBar value={value} onChange={setValue} onSearch={search} autoFocus />
      {/* Both sections are always in the tree, empty and hidden until they have words: one
          appearing beside the focused search bar would make Taro send the page's children again,
          and some phones then drop the keyboard (the history arrives just after it opens). */}
      <View
        className={cx(
          'goods-search__section',
          historyItems.length === 0 && 'goods-search__section--hidden',
        )}
      >
        {historyItems.length > 0 ? (
          <>
            <View className="goods-search__head">
              <Text className="goods-search__title">搜索历史</Text>
              <Pressable
                label="清空搜索历史"
                className="goods-search__clear"
                onClick={() => clearHistory()}
              >
                <Icon name="trash" />
              </Pressable>
            </View>
            <View className="goods-search__words">
              {historyItems.map((item) => (
                <Pressable
                  key={item.keyword}
                  label={item.keyword}
                  className="goods-search__word"
                  onClick={() => search(item.keyword)}
                >
                  {item.keyword}
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </View>
      <View
        className={cx(
          'goods-search__section',
          hotItems.length === 0 && 'goods-search__section--hidden',
        )}
      >
        {hotItems.length > 0 ? (
          <>
            <View className="goods-search__head">
              <Text className="goods-search__title">热门搜索</Text>
            </View>
            <View className="goods-search__words">
              {hotItems.map((item) => (
                <Pressable
                  key={item.keyword}
                  label={item.keyword}
                  className="goods-search__word"
                  onClick={() => search(item.keyword)}
                >
                  {item.keyword}
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </View>
    </PageShell>
  );
}
