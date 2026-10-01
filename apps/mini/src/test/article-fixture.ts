import type { ResponseOf } from '@shop/api-client';

export const articleFixture: ResponseOf<'cms.articleDetail'> = {
  id: '61',
  categoryId: '5',
  categoryTitle: '护理知识',
  title: '日常清洁小贴士',
  slug: null,
  author: '小编',
  coverImageUrl: '/uploads/a/61.jpg',
  summary: '三个步骤，简单好记。',
  sourceUrl: 'https://mp.weixin.qq.com/s/abc',
  isHot: false,
  isBanner: false,
  views: 120,
  sortOrder: 0,
  publishedAt: '2026-09-20T10:00:00+08:00',
  contentHtml:
    '<p>第一步，温水清洗。</p><p>详见 <a href="https://other.example.com/guide">使用指南</a></p>',
  product: {
    id: '11',
    name: '纯棉毛巾',
    imageUrl: '/uploads/p/11.jpg',
    price: '19.90',
    originalPrice: null,
  },
};
