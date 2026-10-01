import type { ResponseOf } from '@shop/api-client';

type Card = ResponseOf<'catalog.productList'>['items'][number];
type Detail = ResponseOf<'catalog.productDetail'>;
type Matrix = ResponseOf<'catalog.productSkus'>;
type Sku = Matrix['skus'][number];

/** A product card as every list answers it. */
export function cardFixture(overrides: Partial<Card> = {}): Card {
  return {
    id: '12',
    name: '柔雾丝绒礼盒',
    subtitle: '亲肤丝绒，简约包装',
    imageUrl: '/uploads/p12.jpg',
    cardImageUrl: null,
    price: '59.00',
    originalPrice: '79.00',
    stock: 20,
    salesDisplay: 128,
    unitName: '件',
    kind: 'physical',
    labels: [],
    canAddToCart: true,
    ...overrides,
  };
}

/** One page of cards. */
export function pageOf(items: Card[], page = 1, total = items.length) {
  return { items, total, page, pageSize: 20 };
}

/** Two level-1 categories; the first has two level-2 children and a banner. */
export const categoryTreeFixture: ResponseOf<'catalog.categoryTree'> = {
  items: [
    {
      id: '1',
      name: '精选好物',
      iconUrl: null,
      bannerUrl: '/uploads/cate-1.jpg',
      children: [
        { id: '11', name: '礼盒', iconUrl: '/uploads/c11.png', bannerUrl: null, children: [] },
        {
          id: '12',
          name: '护理',
          iconUrl: null,
          bannerUrl: null,
          children: [{ id: '121', name: '按摩油', iconUrl: null, bannerUrl: null }],
        },
      ],
    },
    { id: '2', name: '新品', iconUrl: null, bannerUrl: null, children: [] },
  ],
  version: '1-5',
};

export const skuFixture = (
  id: string,
  color: string,
  size: string,
  stock: number,
  price = '59.00',
): Sku => ({
  id,
  skuCode: `S${id}`,
  specText: `${color}|${size}`,
  specValues: { 颜色: color, 尺码: size },
  imageUrl: null,
  price,
  originalPrice: null,
  stock,
  weight: null,
  volume: null,
});

/** 颜色 白/黑 × 尺码 M/L; 白 L is sold out, 黑 L costs more. */
export const skuMatrixFixture: Matrix = {
  productId: '12',
  specMode: true,
  specs: [
    {
      name: '颜色',
      values: [
        { value: '白', imageUrl: null },
        { value: '黑', imageUrl: null },
      ],
    },
    {
      name: '尺码',
      values: [
        { value: 'M', imageUrl: null },
        { value: 'L', imageUrl: null },
      ],
    },
  ],
  skus: [
    skuFixture('101', '白', 'M', 5),
    skuFixture('102', '白', 'L', 0),
    skuFixture('103', '黑', 'M', 2),
    skuFixture('104', '黑', 'L', 1, '65.00'),
  ],
};

/** A product with one SKU and no specs. */
export const singleSkuMatrix = (productId = '31', stock = 9): Matrix => ({
  productId,
  specMode: false,
  specs: [],
  skus: [{ ...skuFixture('301', '', '', stock), specText: '', specValues: {} }],
});

/** 商品详情 for the multi-spec product. */
export function productDetailFixture(overrides: Partial<Detail> = {}): Detail {
  return {
    ...cardFixture(),
    sliderImages: ['/uploads/p12.jpg', '/uploads/p12-b.jpg'],
    videoUrl: null,
    specMode: true,
    minPurchaseQuantity: 1,
    purchaseLimitMode: 'none',
    purchaseLimitQuantity: null,
    freightMode: 'free',
    fixedFreight: null,
    views: 300,
    descriptionHtml: '<p>礼盒图文详情</p>',
    specs: skuMatrixFixture.specs,
    skus: skuMatrixFixture.skus,
    params: [{ name: '材质', value: '丝绒' }],
    protections: [{ id: '1', title: '隐私发货', content: '外包装不显示商品信息', iconUrl: null }],
    customForm: null,
    favorited: false,
    reviewSummary: {
      total: 2,
      goodCount: 2,
      mediumCount: 0,
      badCount: 0,
      withImagesCount: 1,
      averageScore: 4.5,
      goodRate: 100,
    },
    giftCouponIds: [],
    ...overrides,
  };
}

/** A review as 商品评价 lists it. */
export function reviewFixture(
  overrides: Partial<ResponseOf<'catalog.productReviews'>['items'][number]> = {},
) {
  return {
    id: '5001',
    skuId: '103',
    specText: '黑|M',
    authorNickname: '小林',
    authorAvatarUrl: null,
    productScore: 5,
    serviceScore: 5,
    content: '包装很严实，质感不错。',
    images: ['/uploads/r1.jpg'],
    replyContent: null,
    replyAt: null,
    createdAt: '2026-09-01T12:00:00+08:00',
    ...overrides,
  };
}
