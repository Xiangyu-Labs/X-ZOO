import { articleCategoriesPublic } from '@shop/contracts/cms/cms.storefront.contract';
import { categories } from '@shop/core/cms';
import { handle } from '../../../../src/server';

/** The storefront's 文章分类 tab bar: visible categories, nested two deep. */
export const GET = handle(articleCategoriesPublic, (ctx) => categories.publicList(ctx));

export const dynamic = 'force-dynamic';
