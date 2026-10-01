import { Text, View } from '@tarojs/components';

import type { ArticleListProps } from '@shop/contracts/decor/all-blocks';
import type { LinkTarget } from '@shop/contracts/decor/link';
import type { ArticleSummary } from '@shop/contracts/decor/sources';
import { BlockImage } from '../shared/block-image';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ListHead } from '../shared/list-head';
import { formatDate } from '../shared/time';
import type { BlockProps } from '../shared/types';
import styles from './article-list.module.scss';

export interface ArticleListData {
  articles?: readonly ArticleSummary[] | null | undefined;
}

/** 资讯列表, in the source's category when it names one. */
function listLink(props: ArticleListProps): LinkTarget {
  const source = props.source;
  return {
    kind: 'route',
    to: {
      route: 'articleList',
      params:
        source.mode === 'category' && source.categoryId ? { categoryId: source.categoryId } : {},
    },
  };
}

/**
 * 资讯: published articles — a text row with a small cover on the right
 * (`list`), or a wide cover above the title (`card`). A tap opens the article.
 */
export function ArticleList({
  props,
  data,
  onLink,
  host,
}: BlockProps<ArticleListProps, ArticleListData>) {
  const articles = data?.articles ?? [];
  if (articles.length === 0 && !host?.canvas) return null;
  const card = props.layout === 'card';
  return (
    <BlockFrame type="articleList" frame={props.style} className={styles.body}>
      <ListHead
        title={props.title}
        more={props.showMore ? listLink(props) : undefined}
        onLink={onLink}
      />
      {articles.length === 0 ? (
        <View className={styles.empty}>暂无已发布的资讯，商城中不显示此组件</View>
      ) : (
        <View className={cx(styles.items, card ? styles.cards : styles.rows)}>
          {articles.map((article) => {
            const meta = [article.categoryTitle, formatDate(article.publishedAt)]
              .filter(Boolean)
              .join(' · ');
            return (
              <View
                key={article.id}
                className={styles.item}
                data-article={article.id}
                {...tapProps(
                  onLink ? () => onLink({ kind: 'article', id: article.id }) : undefined,
                )}
              >
                {card && article.coverImageUrl ? (
                  <BlockImage
                    className={styles.cover}
                    src={article.coverImageUrl}
                    width={960}
                    resolve={host?.resolveImage}
                    mode="aspectFill"
                    lazyLoad
                  />
                ) : null}
                <View className={styles.text}>
                  <View className={styles.title}>{article.title}</View>
                  {card && article.summary ? (
                    <Text className={styles.summary}>{article.summary}</Text>
                  ) : null}
                  <Text className={styles.meta}>{meta}</Text>
                </View>
                {!card && article.coverImageUrl ? (
                  <BlockImage
                    className={styles.thumb}
                    src={article.coverImageUrl}
                    width={480}
                    resolve={host?.resolveImage}
                    mode="aspectFill"
                    lazyLoad
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </BlockFrame>
  );
}
