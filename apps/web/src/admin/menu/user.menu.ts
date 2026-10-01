import { defineMenu } from './types';

/**
 * 用户 — customers, the taxonomy they are filed under, and the 注销 queue.
 *
 * The permission on each node only decides what the sider shows; the server
 * re-checks the atom declared on the route. Both lists come from
 * `userPermissions` in `@shop/core/user/permissions.ts`, which is why they
 * cannot drift apart silently.
 */
export default defineMenu({
  key: 'user',
  label: '用户',
  icon: 'UserOutlined',
  order: 200,
  children: [
    {
      key: 'user.customers',
      label: '用户列表',
      path: '/admin/user/customers',
      permission: 'user:customer:read',
      order: 10,
    },
    {
      key: 'user.groups',
      label: '用户分组',
      path: '/admin/user/groups',
      permission: 'user:group:read',
      order: 20,
    },
    {
      key: 'user.labels',
      label: '用户标签',
      path: '/admin/user/labels',
      permission: 'user:label:read',
      order: 30,
    },
    {
      key: 'user.cancellations',
      label: '注销申请',
      path: '/admin/user/cancellations',
      permission: 'user:cancellation:read',
      order: 40,
    },
  ],
});
