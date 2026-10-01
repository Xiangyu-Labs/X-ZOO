import { definePermissions } from '../auth/permissions';

/**
 * `system` atoms.
 *
 * One per job somebody actually does, not one per route. `admin:write` covers
 * creating, editing, enabling, disabling and resetting a password, because they
 * are the same job — managing an account; `admin:delete` is separate because
 * deleting one is irreversible and a different person usually signs off on it.
 *
 * `config:read` gates every settings page there is. A group may narrow that by
 * declaring its own `permission`, which is how the payment credentials screen
 * can be visible to fewer people than the site name.
 */
export const systemPermissions = definePermissions(
  'system',
  {
    'admin:read': '查看管理员',
    'admin:write': '新建/编辑管理员、重置密码',
    'admin:delete': '删除管理员',
    'role:read': '查看身份与权限',
    'role:write': '新建/编辑身份',
    'role:delete': '删除身份',
    'audit:read': '查看操作日志',
    'config:read': '查看系统设置',
    'config:write': '修改系统设置',
    'dashboard:read': '查看后台首页统计',
    'job:handle': '查看并处理失败的后台任务',
  },
  { section: '系统' },
);
