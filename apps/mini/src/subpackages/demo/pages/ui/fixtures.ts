import type { StorefrontOrderListItem } from '@shop/contracts/order/schemas';
import type { ProductCardData } from '@/ui/product-card';

/**
 * Made-up data for the gallery. Pictures are drawn here as SVG so the gallery needs no network
 * and no stock photos: a soft gradient, a floor shadow and a simple object.
 */

type Shape = 'gift' | 'bottle' | 'bag' | 'cup' | 'jar' | 'box';

const SHAPES: Record<Shape, string> = {
  gift: "<rect x='62' y='92' width='116' height='92' rx='10' fill='white' fill-opacity='.92'/><rect x='54' y='72' width='132' height='30' rx='8' fill='white'/><rect x='112' y='72' width='16' height='112' fill='HUE_DEEP' fill-opacity='.55'/><path d='M120 72c-18-26-44-22-40-6 3 10 24 8 40 6zm0 0c18-26 44-22 40-6-3 10-24 8-40 6z' fill='HUE_DEEP' fill-opacity='.7'/>",
  bottle:
    "<rect x='104' y='40' width='32' height='26' rx='6' fill='HUE_DEEP' fill-opacity='.75'/><path d='M96 70h48c8 0 14 8 14 18v86c0 10-8 16-18 16h-40c-10 0-18-6-18-16V88c0-10 6-18 14-18z' fill='white' fill-opacity='.95'/><rect x='92' y='112' width='56' height='40' rx='6' fill='HUE_DEEP' fill-opacity='.35'/>",
  bag: "<path d='M92 88c0-22 12-36 28-36s28 14 28 36' fill='none' stroke='white' stroke-width='9' stroke-linecap='round'/><path d='M66 84h108l-8 100c-1 8-6 12-14 12H88c-8 0-13-4-14-12z' fill='white' fill-opacity='.94'/><circle cx='120' cy='132' r='16' fill='HUE_DEEP' fill-opacity='.45'/>",
  cup: "<path d='M74 82h84l-8 96c-1 8-7 14-16 14H98c-9 0-15-6-16-14z' fill='white' fill-opacity='.95'/><path d='M158 100c20 0 22 34 0 36' fill='none' stroke='white' stroke-width='9'/><path d='M104 56c-6 8 6 12 0 20M122 50c-6 8 6 12 0 20' stroke='white' stroke-width='5' stroke-linecap='round' fill='none'/><rect x='80' y='118' width='70' height='14' fill='HUE_DEEP' fill-opacity='.35'/>",
  jar: "<rect x='82' y='52' width='76' height='24' rx='8' fill='HUE_DEEP' fill-opacity='.7'/><rect x='70' y='74' width='100' height='116' rx='22' fill='white' fill-opacity='.94'/><circle cx='120' cy='132' r='26' fill='HUE_DEEP' fill-opacity='.3'/><circle cx='112' cy='126' r='6' fill='white'/>",
  box: "<path d='M120 54l62 30v70l-62 32-62-32V84z' fill='white' fill-opacity='.93'/><path d='M58 84l62 32 62-32M120 116v70' stroke='HUE_DEEP' stroke-opacity='.35' stroke-width='5' fill='none'/>",
};

/** A product picture: a gradient in the given hue with an object on it, as a data URI. */
export function art(hue: number, shape: Shape): string {
  const deep = `hsl(${hue} 55% 42%)`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 240'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue} 85% 88%)'/><stop offset='1' stop-color='hsl(${(hue + 28) % 360} 75% 72%)'/>` +
    `</linearGradient></defs><rect width='240' height='240' fill='url(#g)'/>` +
    `<ellipse cx='120' cy='200' rx='70' ry='10' fill='black' fill-opacity='.08'/>` +
    SHAPES[shape].split('HUE_DEEP').join(deep) +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const label = (id: string, name: string) => ({
  id,
  name,
  style: 'text' as const,
  fontColor: null,
  backgroundColor: null,
  borderColor: null,
  imageUrl: null,
});

export const products: ProductCardData[] = [
  {
    id: '101',
    name: '每日坚果礼盒 30 袋装 混合果仁 办公室零食',
    subtitle: '6 种坚果果干，独立小包',
    imageUrl: art(28, 'gift'),
    cardImageUrl: null,
    price: '79.90',
    originalPrice: '129.00',
    stock: 320,
    salesDisplay: 18_620,
    labels: [label('1', '包邮'), label('2', '新品')],
    canAddToCart: true,
  },
  {
    id: '102',
    name: '冷萃咖啡液 精品挂耳 12 杯',
    subtitle: '云南保山小粒咖啡',
    imageUrl: art(200, 'cup'),
    cardImageUrl: null,
    price: '45.00',
    originalPrice: null,
    stock: 58,
    salesDisplay: 2_310,
    labels: [label('3', '满 99 减 10')],
    canAddToCart: true,
  },
  {
    id: '103',
    name: '山茶花洁面乳 温和清洁 120ml',
    subtitle: null,
    imageUrl: art(330, 'bottle'),
    cardImageUrl: null,
    price: '68.00',
    originalPrice: '98.00',
    stock: 0,
    salesDisplay: 960,
    labels: [],
    canAddToCart: true,
  },
  {
    id: '104',
    name: '手工蜂蜜 百花蜜 500g 玻璃瓶装',
    subtitle: '秦岭深山 自然成熟',
    imageUrl: art(45, 'jar'),
    cardImageUrl: null,
    price: '39.90',
    originalPrice: '59.00',
    stock: 140,
    salesDisplay: 5_402,
    labels: [label('4', '包邮')],
    canAddToCart: true,
  },
  {
    id: '105',
    name: '帆布托特包 大容量 通勤',
    subtitle: null,
    imageUrl: art(150, 'bag'),
    cardImageUrl: null,
    price: '129.00',
    originalPrice: null,
    stock: 12,
    salesDisplay: 432,
    labels: [],
    canAddToCart: false,
  },
  {
    id: '106',
    name: '收纳盒 三件套',
    subtitle: null,
    imageUrl: art(265, 'box'),
    cardImageUrl: null,
    price: '26.80',
    originalPrice: '35.00',
    stock: 999,
    salesDisplay: 12_004,
    labels: [],
    canAddToCart: true,
  },
];

const item = (
  id: string,
  name: string,
  image: string,
  price: string,
  spec: string,
  quantity = 1,
) => ({
  id,
  itemKey: `sku-${id}`,
  productId: id,
  skuId: id,
  productName: name,
  productImageUrl: image,
  productKind: 'physical' as const,
  specText: spec,
  skuImageUrl: null,
  unitName: null,
  quantity,
  unitPrice: price,
  originalUnitPrice: null,
  discountAmount: '0.00',
  totalAmount: price,
  refundedQuantity: 0,
  shippedQuantity: 0,
  adjustments: [],
  reviewed: false,
  reviewable: false,
});

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export const orders: StorefrontOrderListItem[] = [
  {
    id: '9001',
    orderNo: '202609231000000010123456',
    kind: 'normal',
    status: 'pending_payment',
    fulfillmentStatus: 'unfulfilled',
    refundStatus: 'none',
    totalQuantity: 2,
    itemsAmount: '124.90',
    freightAmount: '0.00',
    couponDiscount: '10.00',
    payableAmount: '114.90',
    paidAmount: null,
    payExpiresAt: inMinutes(14.5),
    createdAt: new Date().toISOString(),
    refundedAmount: '0.00',
    hasOpenRefund: false,
    groupbuyTeam: null,
    items: [
      item('1', '每日坚果礼盒 30 袋装', art(28, 'gift'), '79.90', '混合装 | 750g'),
      item('2', '冷萃咖啡液 精品挂耳 12 杯', art(200, 'cup'), '45.00', '中度烘焙'),
    ],
  },
  {
    id: '9002',
    orderNo: '202609201000000010654321',
    kind: 'groupbuy',
    status: 'shipped',
    fulfillmentStatus: 'fulfilled',
    refundStatus: 'none',
    totalQuantity: 3,
    itemsAmount: '119.70',
    freightAmount: '0.00',
    couponDiscount: '0.00',
    payableAmount: '119.70',
    paidAmount: '119.70',
    payExpiresAt: null,
    createdAt: new Date().toISOString(),
    refundedAmount: '0.00',
    hasOpenRefund: false,
    groupbuyTeam: null,
    items: [item('3', '手工蜂蜜 百花蜜 500g 玻璃瓶装', art(45, 'jar'), '39.90', '500g', 3)],
  },
];

export const countdownEnd = inMinutes(2 * 60 + 17.3);
export const presaleEnd = inMinutes(3 * 24 * 60 + 5 * 60);

export const uploaded = [art(28, 'gift'), art(330, 'bottle')];
