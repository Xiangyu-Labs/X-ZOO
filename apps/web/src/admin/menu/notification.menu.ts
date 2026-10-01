import { defineMenu } from './types';

/**
 * 通知 — a top-level menu.
 *
 * Both entries sit under the same atom pair as their routes
 * (`notification:template:read`, `notification:log:read`); the sider only hides
 * things, and the server checks the atom again on every request.
 *
 * The admin inbox has no entry: it is the header bell, which every
 * authenticated admin can use because it holds `auth:profile:read` implicitly.
 */
export default defineMenu({
  key: 'notification',
  label: '通知',
  icon: 'BellOutlined',
  order: 700,
  children: [
    {
      key: 'notification.templates',
      label: '通知模板',
      path: '/admin/notification/templates',
      permission: 'notification:template:read',
      order: 10,
    },
    {
      key: 'notification.logs',
      label: '发送记录',
      path: '/admin/notification/logs',
      permission: 'notification:log:read',
      order: 20,
    },
  ],
});
