import { defineMenu } from './types';

/**
 * 营销 → 预售.
 *
 * One file per domain, aggregated by `pnpm gen` into the gitignored
 * `menu.gen.ts`, so adding a domain touches no shared index.
 *
 * `permission` here only decides what the sider shows; the server checks the
 * atom declared on each route again. The two lists must agree, which is why
 * both come from `presalePermissions` in `@shop/core/presale/permissions.ts`.
 *
 * Two nodes with two different atoms, because 预售活动 and 预售订单 answer to
 * different people: 运营 sets the price, 客服 answers "when does mine ship".
 */
export default defineMenu({
  key: 'presale',
  label: '预售',
  icon: 'ScheduleOutlined',
  order: 320,
  children: [
    {
      key: 'presale.activities',
      label: '预售活动',
      path: '/admin/presale/activities',
      permission: 'presale:activity:read',
      order: 10,
    },
    {
      key: 'presale.orders',
      label: '预售订单',
      path: '/admin/presale/orders',
      permission: 'presale:order:read',
      order: 20,
    },
  ],
});
