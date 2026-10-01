import type { PageDocument } from './document';

/**
 * The built-in 个人中心 (plan §2.2).
 *
 * Served by `GET /api/v1/pages/user-center` whenever no document is designated
 * as the user centre — a shop that never decorated 我的 still needs its orders
 * and its services. The resolver treats it exactly like a published revision
 * (`id: null`, `revision: null`). `defaults.test.ts` holds it to the strict
 * check, so it can never drift from the block schemas.
 *
 * Plain data (no zod), so a client may import it as its offline fallback.
 */
export const USER_CENTER_DEFAULT_DOCUMENT: PageDocument = {
  schemaVersion: 2,
  root: {
    props: {
      title: '个人中心',
      background: '#f5f5f5',
      shareEnabled: false,
      shareTitle: '',
    },
  },
  blocks: [
    {
      id: 'default-user-card',
      type: 'userCard',
      v: 1,
      props: {
        showStats: true,
        style: { marginY: 'none', paddingX: 'none', radius: 'none' },
        visibility: { audience: 'all', platforms: [] },
      },
    },
    {
      id: 'default-order-entry',
      type: 'orderEntry',
      v: 1,
      props: {
        title: '我的订单',
        items: [
          { key: 'unpaid', label: '待付款' },
          { key: 'unshipped', label: '待发货' },
          { key: 'unreceived', label: '待收货' },
          { key: 'unreviewed', label: '待评价' },
          { key: 'aftersale', label: '售后/退款' },
        ],
        style: { marginY: 'sm', paddingX: 'sm', radius: 'sm' },
        visibility: { audience: 'all', platforms: [] },
      },
    },
    {
      id: 'default-service-grid',
      type: 'serviceGrid',
      v: 1,
      props: {
        title: '我的服务',
        columns: 4,
        items: [
          {
            label: '优惠券',
            action: 'link',
            link: { kind: 'route', to: { route: 'myCoupons', params: {} } },
          },
          {
            label: '领券中心',
            action: 'link',
            link: { kind: 'route', to: { route: 'couponCenter', params: {} } },
          },
          {
            label: '我的拼团',
            action: 'link',
            link: { kind: 'route', to: { route: 'myGroupbuys', params: {} } },
          },
          {
            label: '收货地址',
            action: 'link',
            link: { kind: 'route', to: { route: 'addresses', params: {} } },
          },
          {
            label: '我的收藏',
            action: 'link',
            link: { kind: 'route', to: { route: 'favorites', params: {} } },
          },
          {
            label: '浏览记录',
            action: 'link',
            link: { kind: 'route', to: { route: 'history', params: {} } },
          },
          {
            label: '我的评价',
            action: 'link',
            link: { kind: 'route', to: { route: 'myReviews', params: {} } },
          },
          {
            label: '发票管理',
            action: 'link',
            link: { kind: 'route', to: { route: 'invoices', params: {} } },
          },
          {
            label: '消息中心',
            action: 'link',
            link: { kind: 'route', to: { route: 'messages', params: {} } },
          },
          { label: '联系客服', action: 'contact' },
          {
            label: '设置',
            action: 'link',
            link: { kind: 'route', to: { route: 'settings', params: {} } },
          },
        ],
        style: { marginY: 'sm', paddingX: 'sm', radius: 'sm' },
        visibility: { audience: 'all', platforms: [] },
      },
    },
  ],
};

/** The `version` the built-in 个人中心 is served with. Bump when it changes. */
export const USER_CENTER_DEFAULT_VERSION = 'builtin-user-center-v2-2';
