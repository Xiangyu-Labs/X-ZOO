import { z } from 'zod';

import { blockProps } from '../base';
import { ARTICLE_LIST_LAYOUTS, type ArticleListLayout } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { articleSource, need } from '../sources';
import { listHeading } from './list-heading';

/**
 * 资讯: published articles, picked by id or the newest `limit` of a category
 * (or of all). `list` is a text row with a small cover on the right; `card` a
 * full-width cover above the title. A tap opens the article.
 */
export const articleListProps = blockProps({
  ...listHeading('资讯'),
  source: articleSource
    .default({ mode: 'category', limit: 3 })
    .meta(ui({ label: '资讯来源', field: 'articleSource', group: '内容' })),
  layout: z
    .enum(Object.keys(ARTICLE_LIST_LAYOUTS) as [ArticleListLayout, ...ArticleListLayout[]])
    .default('list')
    .meta(ui({ label: '列表样式', field: 'radio', options: ARTICLE_LIST_LAYOUTS, group: '展示' })),
});
export type ArticleListProps = z.infer<typeof articleListProps>;

export const articleListBlock = defineBlock({
  type: 'articleList',
  v: 1,
  props: articleListProps,
  meta: { label: '资讯', pages: ['home', 'custom', 'user_center'] },
  data: (props) => ({ articles: need.articles(props.source) }),
});
