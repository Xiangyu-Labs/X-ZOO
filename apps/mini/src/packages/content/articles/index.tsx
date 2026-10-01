import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import { useInfiniteRouteQuery, useRouteQuery } from '@shop/api-client/react';
import { assetUrl } from '@/lib/asset-url';
import { formatDate } from '@/lib/format';
import { navigate, scrollPageToTop, useRouteParams, useShare } from '@/platform';
import { Empty } from '@/ui/empty';
import { Image } from '@/ui/image';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import './index.scss';

type Article = ResponseOf<'cms.articleList'>['items'][number];
type Category = ResponseOf<'cms.categoryList'>['items'][number];

const ALL = 'all';

/** A top-level category's articles include its sub-categories'. */
export function categoryFilter(
  categories: readonly Category[],
  key: string,
): { categoryIds?: string } {
  if (key === ALL) return {};
  const category = categories.find((c) => c.id === key);
  const ids = category ? [category.id, ...category.children.map((c) => c.id)] : [key];
  return { categoryIds: ids.join(',') };
}

/**
 * 资讯 (`articleList { categoryId? }`, pages.md §2.7): 全部 plus a tab per top-level category,
 * newest first. Shareable to a friend, on the category it was opened with.
 */
export default function ArticlesPage() {
  const params = useRouteParams('articleList');
  const categories = useRouteQuery('cms.categoryList', {});
  const items = categories.data?.items ?? [];
  const [tab, setTab] = useState(params.categoryId ?? ALL);
  const current = items.find((c) => c.id === tab);

  useShare(
    { route: 'articleList', params: tab === ALL ? {} : { categoryId: tab } },
    { title: current ? current.title : '资讯' },
  );

  return (
    <PageShell title="资讯">
      {items.length > 0 ? (
        <Tabs
          sticky
          items={[
            { key: ALL, label: '全部' },
            ...items.map((c) => ({ key: c.id, label: c.title })),
          ]}
          value={tab}
          onChange={(key) => {
            setTab(key);
            scrollPageToTop();
          }}
        />
      ) : null}
      <ArticleList key={tab} filter={categoryFilter(items, tab)} />
    </PageShell>
  );
}

function ArticleList({ filter }: { filter: { categoryIds?: string } }) {
  const list = useInfiniteRouteQuery('cms.articleList', { query: { pageSize: 10, ...filter } });
  return (
    <View className="articles">
      <InfiniteList
        query={list}
        itemKey={(article) => article.id}
        skeleton={<CellSkeleton rows={4} />}
        empty={<Empty title="暂无资讯" />}
        renderItem={(article) => <ArticleRow article={article} />}
      />
    </View>
  );
}

function ArticleRow({ article }: { article: Article }) {
  const date = article.publishedAt ? formatDate(article.publishedAt) : null;
  return (
    <Pressable
      label={article.title}
      role="link"
      className="article-row"
      onClick={() => navigate({ route: 'article', params: { id: article.id } })}
    >
      <View className="article-row__text">
        <Text className="article-row__title">{article.title}</Text>
        {article.summary ? <Text className="article-row__summary">{article.summary}</Text> : null}
        <Text className="article-row__meta">
          {[date, article.views > 0 ? `${article.views} 阅读` : null].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {article.coverImageUrl ? (
        <View className="article-row__cover">
          <Image src={assetUrl(article.coverImageUrl)} ratio={4 / 3} radius="sm" size="small" />
        </View>
      ) : null}
    </Pressable>
  );
}
