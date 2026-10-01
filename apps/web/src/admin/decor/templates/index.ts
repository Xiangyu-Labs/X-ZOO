import type { DocumentKind } from '@shop/contracts/decor/constants';
import type { StoredDocument } from '@shop/contracts/decor/document';

import { CUSTOM_CAMPAIGN, HOME_MODERN, USER_CENTER_CLEAN } from './documents';

/**
 * 从模板新建: the starting documents offered when a page is created.
 *
 * Templates are code, not rows: a template is a `StoredDocument` the create
 * call sends as the new page's first draft (`decorDocumentCreate { document }`),
 * checked by the server like any draft. Nothing is seeded, so creating from a
 * template is idempotent by construction — each use is a new, independent page
 * — and a shop that never opens the editor has no decor rows at all. A
 * template that names a block this build no longer has fails the templates
 * test, not an operator.
 */
export interface DecorTemplate {
  key: string;
  kind: DocumentKind;
  name: string;
  description: string;
  /** Omitted: the blank page (the server titles it after the page name). */
  document?: StoredDocument | undefined;
}

export const BLANK_TEMPLATE_KEY = 'blank';

const BLANK: Omit<DecorTemplate, 'kind'> = {
  key: BLANK_TEMPLATE_KEY,
  name: '空白页面',
  description: '从零开始，自己添加组件。',
};

export const DECOR_TEMPLATES: readonly DecorTemplate[] = [
  {
    key: 'home-modern',
    kind: 'home',
    name: '简约首页',
    description:
      '搜索、轮播、快捷入口、公告、领券、图片魔方、新品横滑和商品选项卡。换上图片、选好商品即可发布。',
    document: HOME_MODERN,
  },
  {
    key: 'user-center-clean',
    kind: 'user_center',
    name: '简洁个人中心',
    description: '用户卡片、订单入口，服务按「优惠与记录」「账户与服务」分两组。',
    document: USER_CENTER_CLEAN,
  },
  {
    key: 'custom-campaign',
    kind: 'custom',
    name: '专题活动',
    description: '专题主图、活动说明、一大两小的图片魔方和活动商品。',
    document: CUSTOM_CAMPAIGN,
  },
];

/** The templates for a kind, the blank page first. */
export function templatesFor(kind: DocumentKind): DecorTemplate[] {
  return [{ ...BLANK, kind }, ...DECOR_TEMPLATES.filter((template) => template.kind === kind)];
}
