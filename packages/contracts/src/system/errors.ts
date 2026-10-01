import { defineErrors } from '../_conventions/errors';

/**
 * `system` error codes.
 *
 * One code per decision the caller can act on. The generic 401/403/404/422
 * cases come from `commonErrors` and are not repeated; what is here is either a
 * refusal an operator must understand ("this role is still in use") or a safety
 * rule ("you cannot disable yourself").
 */
export const systemErrors = defineErrors({
  /** The admin id does not exist or is soft-deleted. */
  SYSTEM_ADMIN_NOT_FOUND: { status: 404, message: '管理员不存在' },
  /** `admins_account_lower_key` refused the insert. Login names are case-insensitive. */
  SYSTEM_ADMIN_ACCOUNT_TAKEN: { status: 409, message: '该账号已被使用' },
  /** Creating an admin without a password. Editing one may omit it. */
  SYSTEM_ADMIN_PASSWORD_REQUIRED: { status: 422, message: '新建管理员时必须设置密码' },
  /**
   * Disabling, deleting or demoting yourself, or the last enabled super admin.
   * One code, because the answer is the same: somebody else has to do it.
   */
  SYSTEM_ADMIN_SELF_LOCKOUT: {
    status: 409,
    message: '不能停用或删除自己，也不能移除最后一个超级管理员',
  },
  /**
   * A non-super admin tried to grant, or to manage, more than they hold: a role
   * with an atom they lack, or an admin (a super admin included) whose grants
   * go beyond theirs. `details` carries `{ permissions }` when atoms are the reason.
   */
  SYSTEM_GRANT_EXCEEDS_OWN: {
    status: 403,
    message: '不能授予或管理超出自己权限范围的身份或管理员',
  },
  /** `roleIds` named a role that does not exist. `details` carries `{ roleIds }`. */
  SYSTEM_ROLE_UNKNOWN: { status: 422, message: '部分身份不存在，请刷新后重试' },

  SYSTEM_ROLE_NOT_FOUND: { status: 404, message: '身份不存在' },
  SYSTEM_ROLE_NAME_TAKEN: { status: 409, message: '该身份名称已存在' },
  /** Deleting a role some admin still holds. `details` carries `{ adminCount }`. */
  SYSTEM_ROLE_IN_USE: { status: 409, message: '该身份仍有管理员在使用，无法删除' },
  /**
   * A permission atom the code does not declare. Atoms are compiled in, so this
   * is a stale browser tab or a hand-made request, never data drift.
   * `details` carries `{ permissions }`.
   */
  SYSTEM_PERMISSION_UNKNOWN: { status: 422, message: '包含未知的权限项，请刷新页面后重试' },

  /** The current password did not match. Deliberately distinct from a 401. */
  SYSTEM_PASSWORD_MISMATCH: { status: 422, message: '当前密码不正确' },

  /** No failed background job with that id. */
  SYSTEM_FAILED_JOB_NOT_FOUND: { status: 404, message: '该任务记录不存在' },

  /** No config group is registered under that name. */
  SYSTEM_CONFIG_GROUP_NOT_FOUND: { status: 404, message: '配置分组不存在' },
  /**
   * The patch contained a key the group's schema does not declare. Saving it
   * would create a row nothing ever reads. `details` carries `{ keys }`.
   */
  SYSTEM_CONFIG_UNKNOWN_KEY: { status: 422, message: '包含未知的配置项' },
  /** 「测试」 on a group that has no test hook. A stale tab or a hand-made request. */
  SYSTEM_CONFIG_TEST_UNSUPPORTED: { status: 404, message: '这个配置分组没有测试功能' },
  /**
   * The patch named a `readOnly` field — one the deployment's environment
   * decides, not an operator. The settings screen renders those as plain text
   * and never submits them, so this is a stale tab or a hand-made request.
   * `details` carries `{ keys }`.
   */
  CONFIG_FIELD_READ_ONLY: { status: 422, message: '该配置项由部署环境决定，不能在后台修改' },
});

export type SystemErrorCode = keyof typeof systemErrors;
