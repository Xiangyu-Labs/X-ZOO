import { definePermissions } from '../auth/permissions';

/**
 * Ten atoms, one per job somebody actually does.
 *
 * `status` and `password` are split out of `write` because they are different
 * jobs with different blast radii: editing a nickname is clerical, disabling an
 * account or resetting its password kills every live session of a paying
 * customer. A support agent gets `read` + `password`; a marketer gets `read` +
 * `write` and cannot ban anybody.
 *
 * Label categories share the label atoms — the same person maintains both on
 * the same screen, and a third pair nobody would ever grant separately is how
 * permission trees become unreadable.
 *
 * Customers get `customer:read` / `customer:write` rather than one atom per
 * action, because per-action atoms would name CRUD verbs on one screen.
 */
export const userPermissions = definePermissions(
  'user',
  {
    'customer:read': '查看用户',
    'customer:write': '编辑用户、设置分组与标签',
    'customer:status': '启用/禁用用户',
    'customer:password': '重置用户密码',
    'group:read': '查看用户分组',
    'group:write': '新建/编辑/删除用户分组',
    'label:read': '查看用户标签',
    'label:write': '新建/编辑/删除用户标签',
    'cancellation:read': '查看注销申请',
    'cancellation:review': '审核注销申请',
  },
  { section: '用户' },
);
