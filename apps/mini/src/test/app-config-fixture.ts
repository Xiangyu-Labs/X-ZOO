import type { AppConfig } from '@/app-config';

/** A filled-in `GET /app/config` (the contract's example, spelled out: tests import no zod). */
export const appConfigFixture: AppConfig = {
  name: '示例商城',
  logo: { main: null, login: null, square: null, favicon: null },
  share: { title: '好物一站购齐', synopsis: '', image: null },
  support: { kind: 'mini-program', phone: '400-000-0000', qrcodeUrl: null },
  auth: { wechatOa: false, wechatMini: true, phone: true, wechatRequiresPhone: true },
  payments: { wechat: true },
  splashAd: { enabled: false, imageUrl: null, link: null, seconds: 3 },
  subscribeTemplates: {
    orderCreate: [],
    orderPay: ['tpl-order-paid'],
    orderUnpaid: [],
    orderShip: ['tpl-shipped', 'tpl-delivered'],
    refund: ['tpl-refund'],
  },
  subscribeScenes: {
    checkout: ['tpl-shipped', 'tpl-delivered', 'tpl-order-paid'],
    groupbuyCheckout: ['tpl-shipped', 'tpl-delivered', 'tpl-order-paid'],
    presaleCheckout: ['tpl-shipped', 'tpl-delivered', 'tpl-order-paid'],
    refundApply: ['tpl-refund'],
    returnShipment: ['tpl-refund'],
  },
  webviewDomains: [],
  assetOrigin: null,
  appearance: {
    theme: {
      primaryColor: '#1677FF',
      primaryContrastColor: '#FFFFFF',
      accentColor: null,
      priceColor: '#FF4D4F',
      radius: 'large',
    },
    tabBar: {
      color: '#666666',
      selectedColor: '#1677FF',
      backgroundColor: '#FFFFFF',
      items: [
        { key: 'home', label: '首页', iconUrl: null, selectedIconUrl: null },
        { key: 'category', label: '分类', iconUrl: null, selectedIconUrl: null },
        { key: 'cart', label: '购物车', iconUrl: null, selectedIconUrl: null },
        { key: 'me', label: '我的', iconUrl: null, selectedIconUrl: null },
      ],
    },
  },
  display: {
    categorySubcategories: true,
    productReviews: true,
    productRecommendations: true,
    productServiceTags: true,
    productPoster: true,
  },
  version: '1758500000000',
  serverTime: '2026-09-24T08:00:00.000+08:00',
};
