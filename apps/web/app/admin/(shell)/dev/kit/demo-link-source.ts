import type { LinkSource, LinkTarget, LinkTargetType } from '@/admin/kit/link/types';

/**
 * The kit demo's `LinkSource`: a handful of in-memory rows, like the rest of
 * this page's data. `<LinkPicker>` has no fallback source, so the demo mounts
 * this one.
 */

const PATHS: Record<Exclude<LinkTargetType, 'page' | 'custom'>, [string, string]> = {
  product: ['商品', '/pages/goods_details/index?id='],
  category: ['分类', '/pages/goods/goods_list/index?cid='],
  article: ['文章', '/pages/extension/news_details/index?id='],
};

const NAMES = ['秋季新款外套', '云南普洱茶饼', '无线蓝牙耳机', '厨房收纳三件套', '儿童绘本套装'];

export function createDemoLinkSource(): LinkSource {
  return {
    async listPages() {
      return [
        {
          group: '基础页面',
          items: [
            { id: 'home', name: '首页', url: '/pages/index/index' },
            { id: 'category', name: '分类', url: '/pages/goods_cate/goods_cate' },
            { id: 'cart', name: '购物车', url: '/pages/order_addcart/order_addcart' },
            { id: 'user', name: '个人中心', url: '/pages/user/index' },
          ],
        },
      ];
    },
    async listTargets(type, query) {
      const [label, prefix] = PATHS[type];
      const all: LinkTarget[] = NAMES.map((name, index) => ({
        id: String(index + 1),
        name: `${label}：${name}`,
        url: `${prefix}${index + 1}`,
        subtitle: `ID ${index + 1}`,
      }));
      const keyword = query.keyword?.trim();
      const filtered = keyword ? all.filter((item) => item.name.includes(keyword)) : all;
      const start = (query.page - 1) * query.pageSize;
      return { items: filtered.slice(start, start + query.pageSize), total: filtered.length };
    },
  };
}
