'use client';

import type { ArticleCategoryStatus, ArticleStatus } from '@shop/contracts/cms/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The CMS enums, in one file next to the pages.
 *
 * The keys are the contract's own unions, so dropping a value from the contract
 * is a compile error here rather than a blank tag in production, and the table
 * column, the filter bar and the form all read the same labels.
 */

export const ARTICLE_STATUS: StatusMap<ArticleStatus> = {
  draft: { label: '草稿', color: 'default' },
  published: { label: '已发布', color: 'success' },
  hidden: { label: '已隐藏', color: 'warning' },
};

export const ARTICLE_CATEGORY_STATUS: StatusMap<ArticleCategoryStatus> = {
  visible: { label: '显示', color: 'success' },
  hidden: { label: '隐藏', color: 'default' },
};
