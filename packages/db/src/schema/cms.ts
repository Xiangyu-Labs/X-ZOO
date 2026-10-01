import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, instant, pk, updatedAt } from './_shared';
import { products } from './catalog';

/** Articles and their categories. The long HTML body is split out of the list row. */

export const articleCategoriesStatus = pgEnum('article_categories_status', ['visible', 'hidden']);

export const articleCategories = pgTable(
  'article_categories',
  {
    id: pk(),
    parentId: fk().references((): AnyPgColumn => articleCategories.id, { onDelete: 'restrict' }),
    title: varchar({ length: 100 }).notNull(),
    intro: varchar({ length: 255 }),
    imageUrl: varchar({ length: 512 }),
    status: articleCategoriesStatus().notNull().default('visible'),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('article_categories_parent_idx').on(t.parentId),
    index('article_categories_status_idx').on(t.status, t.sortOrder),
  ],
);

export type ArticleCategory = typeof articleCategories.$inferSelect;
export type NewArticleCategory = typeof articleCategories.$inferInsert;

export const articlesStatus = pgEnum('articles_status', ['draft', 'published', 'hidden']);

export const articles = pgTable(
  'articles',
  {
    id: pk(),
    categoryId: fk().references(() => articleCategories.id, { onDelete: 'restrict' }),
    title: varchar({ length: 255 }).notNull(),
    /** Stable URL segment. Optional; the numeric id always works. */
    slug: varchar({ length: 255 }),
    author: varchar({ length: 64 }),
    coverImageUrl: varchar({ length: 512 }),
    summary: varchar({ length: 255 }),
    shareTitle: varchar({ length: 255 }),
    shareSummary: varchar({ length: 255 }),
    /** External original, when the article merely links out. */
    sourceUrl: varchar({ length: 512 }),
    /** Optional product this article promotes. */
    productId: fk().references(() => products.id, { onDelete: 'set null' }),
    status: articlesStatus().notNull().default('draft'),
    isHot: boolean().notNull().default(false),
    isBanner: boolean().notNull().default(false),
    views: integer().notNull().default(0),
    sortOrder: integer().notNull().default(0),
    publishedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('articles_slug_uq').on(t.slug),
    index('articles_category_idx').on(t.categoryId, t.status, t.sortOrder),
    index('articles_status_idx').on(t.status, t.publishedAt),
    index('articles_product_idx').on(t.productId),
    check('articles_views_non_negative', sql`${t.views} >= 0`),
    check(
      'articles_published_shape',
      sql`${t.status} <> 'published' or ${t.publishedAt} is not null`,
    ),
  ],
);

export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;

export const articleContents = pgTable('article_contents', {
  articleId: fk()
    .primaryKey()
    .references(() => articles.id, { onDelete: 'cascade' }),
  /** Sanitised HTML. */
  contentHtml: text().notNull(),
  updatedAt: updatedAt(),
});

export type ArticleContent = typeof articleContents.$inferSelect;
export type NewArticleContent = typeof articleContents.$inferInsert;
