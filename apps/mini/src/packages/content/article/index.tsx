import { Text, View } from '@tarojs/components';
import type { ResponseOf } from '@shop/api-client';
import { useRouteQuery } from '@shop/api-client/react';
import { extractLinks } from '@/features/content/links';
import { RichContent } from '@/features/content/rich-content';
import { assetUrl } from '@/lib/asset-url';
import { formatDate } from '@/lib/format';
import { strikePrice } from '@/lib/money';
import { navigate, openExternalLink, useRouteParams, useShare } from '@/platform';
import { Cell, CellGroup } from '@/ui/cell';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import './index.scss';

type Article = ResponseOf<'cms.articleDetail'>;

/**
 * 资讯详情 (`article { id }`, pages.md §2.7): the operator's HTML through `rich-text`, the linked
 * product, 阅读原文. Links inside `rich-text` cannot be tapped, so they are listed under the
 * body and open through the web-view check (C12): a 业务域名 opens, anything else is copied.
 * Shareable to a friend and to 朋友圈 (the article's own title and cover).
 */
export default function ArticlePage() {
  const { id } = useRouteParams('article');
  return (
    <PageShell title="资讯详情" bg="surface">
      {id ? <ArticleView id={id} /> : <Empty title="文章不存在" />}
    </PageShell>
  );
}

function ArticleView({ id }: { id: string }) {
  const query = useRouteQuery('cms.articleDetail', { params: { id } });
  const article = query.data;
  useShare(article ? { route: 'article', params: { id } } : null, {
    ...(article ? { title: article.title } : {}),
    ...(article?.coverImageUrl ? { imageUrl: assetUrl(article.coverImageUrl) ?? '' } : {}),
  });
  if (query.isPending) return <CellSkeleton rows={6} />;
  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => query.refetch()} />;
  return <ArticleBody article={query.data} />;
}

function ArticleBody({ article }: { article: Article }) {
  const links = extractLinks(article.contentHtml);
  const meta = [
    article.categoryTitle,
    article.author,
    article.publishedAt ? formatDate(article.publishedAt) : null,
    // 「0 阅读」 says nobody cares; say nothing until someone has read it.
    article.views > 0 ? `${article.views} 阅读` : null,
  ].filter(Boolean);
  return (
    <View className="article">
      <Text className="article__title">{article.title}</Text>
      <Text className="article__meta">{meta.join(' · ')}</Text>
      <View className="article__body">
        <RichContent html={article.contentHtml} />
      </View>
      {article.product ? <LinkedProduct product={article.product} /> : null}
      {links.length > 0 || article.sourceUrl ? (
        <CellGroup inset={false} title="相关链接" className="article__links">
          {links.map((link) => (
            <Cell
              key={link.href}
              title={link.text}
              label={`打开链接：${link.text}`}
              onClick={() => openExternalLink(link.href)}
            />
          ))}
          {article.sourceUrl ? (
            <Cell title="阅读原文" onClick={() => openExternalLink(article.sourceUrl ?? '')} />
          ) : null}
        </CellGroup>
      ) : null}
    </View>
  );
}

function LinkedProduct({ product }: { product: NonNullable<Article['product']> }) {
  const strike = strikePrice(product.price, product.originalPrice);
  return (
    <Pressable
      label={product.name}
      role="link"
      className="article-product"
      onClick={() => navigate({ route: 'product', params: { id: product.id } })}
    >
      <View className="article-product__image">
        <Image src={assetUrl(product.imageUrl)} ratio={1} radius="sm" size="small" />
      </View>
      <View className="article-product__text">
        <Text className="article-product__name">{product.name}</Text>
        <View className="article-product__prices">
          <Price value={product.price} size="sm" />
          {strike ? <Price value={strike} size="sm" strike /> : null}
        </View>
      </View>
      <Icon name="chevron-right" className="article-product__arrow" />
    </Pressable>
  );
}
