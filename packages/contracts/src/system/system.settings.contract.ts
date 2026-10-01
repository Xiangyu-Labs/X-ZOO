import { defineRoute } from '../_conventions/route';
import {
  agreement,
  agreementExample,
  agreementParams,
  auditLogItemExample,
  auditLogListQuery,
  configGroupList,
  configGroupParams,
  configGroupSummaryExample,
  configGroupValues,
  configGroupValuesExample,
  configSaveBody,
  configTestBody,
  configTestResult,
  dashboardHeader,
  dashboardHeaderExample,
  pagedAuditLogs,
} from './schemas';

/**
 * The audit log, the generic settings screen and the dashboard header.
 *
 * **One settings page, not fifty.** There is no hand-built screen per config
 * tab. A domain declares a group with `defineConfigGroup` and
 * `GET /admin-api/system/config-groups` lists whatever is registered;
 * `/admin-api/system/config/:group` reads and writes it, and one
 * `<ConfigGroupForm>` renders it.
 *
 * **Secrets never travel.** A field marked `secret` comes back as a boolean
 * "is set" flag, and a save that omits the key leaves the stored value alone.
 * There is no route, anywhere, that returns a stored credential.
 */

export const systemAuditLogList = defineRoute({
  id: 'system.auditLogList',
  method: 'GET',
  path: '/admin-api/audit-logs',
  auth: 'admin',
  permission: 'system:audit:read',
  summary: '操作日志',
  tags: ['system'],
  query: auditLogListQuery,
  response: pagedAuditLogs,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [auditLogItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'by-admin-and-window',
      query: {
        page: 1,
        pageSize: 20,
        adminId: '1',
        createdFrom: '2026-09-21T00:00:00+08:00',
        createdTo: '2026-09-22T00:00:00+08:00',
      },
      response: { items: [auditLogItemExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const systemConfigGroupList = defineRoute({
  id: 'system.configGroupList',
  method: 'GET',
  path: '/admin-api/system/config-groups',
  auth: 'admin',
  permission: 'system:config:read',
  summary: '配置分组列表',
  tags: ['system'],
  response: configGroupList,
  examples: [
    {
      name: 'ok',
      response: {
        groups: [
          configGroupSummaryExample,
          {
            group: 'storage',
            title: '存储设置',
            description: '上传驱动、大小上限与 S3 凭据。',
            permission: 'system:config:read',
            fieldCount: 11,
            writable: true,
          },
        ],
      },
    },
  ],
});

export const systemConfigGet = defineRoute({
  id: 'system.configGet',
  method: 'GET',
  path: '/admin-api/system/config/:group',
  auth: 'admin',
  permission: 'system:config:read',
  summary: '读取配置分组',
  tags: ['system'],
  params: configGroupParams,
  response: configGroupValues,
  errors: ['SYSTEM_CONFIG_GROUP_NOT_FOUND'],
  examples: [
    { name: 'site', params: { group: 'site' }, response: configGroupValuesExample },
    {
      name: 'secret-is-a-flag',
      params: { group: 'storage' },
      response: {
        descriptor: {
          group: 'storage',
          title: '存储设置',
          permission: 'system:config:read',
          fields: [
            {
              key: 'driver',
              label: '存储驱动',
              kind: 'select',
              options: [
                { label: '本地磁盘', value: 'local' },
                { label: 'S3 兼容对象存储', value: 's3' },
              ],
            },
            {
              key: 's3SecretAccessKey',
              label: 'SecretAccessKey',
              kind: 'password',
              secret: true,
              visibleWhen: { key: 'driver', equals: 's3' },
            },
          ],
        },
        // `true` means 已设置. The stored secret itself is never sent.
        values: { driver: 's3', s3SecretAccessKey: true },
        updatedAt: '2026-09-20T18:30:00+08:00',
      },
    },
  ],
});

export const systemConfigSave = defineRoute({
  id: 'system.configSave',
  method: 'PUT',
  path: '/admin-api/system/config/:group',
  auth: 'admin',
  permission: 'system:config:write',
  summary: '保存配置分组',
  tags: ['system'],
  params: configGroupParams,
  body: configSaveBody,
  response: configGroupValues,
  // A payment group answers an API token AUTH_TOKEN_CONSOLE_ONLY.
  errors: [
    'SYSTEM_CONFIG_GROUP_NOT_FOUND',
    'SYSTEM_CONFIG_UNKNOWN_KEY',
    'CONFIG_FIELD_READ_ONLY',
    'AUTH_TOKEN_CONSOLE_ONLY',
  ],
  examples: [
    {
      name: 'rename-the-shop',
      params: { group: 'site' },
      body: { values: { siteName: 'X-ZOO 旗舰店' } },
      response: {
        ...configGroupValuesExample,
        values: { ...configGroupValuesExample.values, siteName: 'X-ZOO 旗舰店' },
        updatedAt: '2026-09-22T09:05:00+08:00',
      },
    },
  ],
});

/**
 * 「测试」: tries the values on the screen without saving them.
 *
 * Password boxes left empty fall back to the stored secret, so an operator can
 * change the sign name and test it without retyping the key. The result is a
 * list of steps rather than a 4xx, because a provider's refusal is the answer
 * the operator asked for, not an error in the request.
 */
export const systemConfigTest = defineRoute({
  id: 'system.configTest',
  method: 'POST',
  path: '/admin-api/system/config/:group/test',
  auth: 'admin',
  permission: 'system:config:write',
  summary: '测试配置分组',
  tags: ['system'],
  params: configGroupParams,
  body: configTestBody,
  response: configTestResult,
  errors: [
    'SYSTEM_CONFIG_GROUP_NOT_FOUND',
    'SYSTEM_CONFIG_UNKNOWN_KEY',
    'CONFIG_FIELD_READ_ONLY',
    'SYSTEM_CONFIG_TEST_UNSUPPORTED',
    'AUTH_TOKEN_CONSOLE_ONLY',
    'RATE_LIMITED',
  ],
  examples: [
    {
      name: 'sms-sent',
      params: { group: 'sms' },
      body: {
        values: { provider: 'tencent', tencentSignName: '某某商城' },
        input: { phone: '13800138000' },
      },
      response: {
        ok: true,
        steps: [
          { name: '检查配置', ok: true, detail: '腾讯云 · 签名「某某商城」', ms: 0 },
          { name: '发送验证码短信', ok: true, detail: '已受理，消息 ID 2433:1234567890', ms: 312 },
        ],
      },
    },
    {
      name: 'storage-refused',
      params: { group: 'storage' },
      body: { values: { driver: 's3', s3Bucket: 'shop' }, input: {} },
      response: {
        ok: false,
        steps: [{ name: '写入探针文件', ok: false, detail: 'S3 403 AccessDenied', ms: 120 }],
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// agreements
// ---------------------------------------------------------------------------

export const systemAgreementGet = defineRoute({
  id: 'system.agreementGet',
  method: 'GET',
  path: '/api/v1/agreements/:key',
  auth: 'public',
  summary: '协议内容',
  tags: ['system'],
  params: agreementParams,
  response: agreement,
  examples: [
    { name: 'user', params: { key: 'user' }, response: agreementExample },
    {
      name: 'never-filled-in',
      params: { key: 'cancellation' },
      response: { key: 'cancellation', title: '注销协议', content: '', updatedAt: null },
    },
  ],
});

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

export const systemDashboardHeader = defineRoute({
  id: 'system.dashboardHeader',
  method: 'GET',
  path: '/admin-api/dashboard/header',
  auth: 'admin',
  permission: 'system:dashboard:read',
  summary: '后台首页头部统计',
  tags: ['system'],
  response: dashboardHeader,
  examples: [
    { name: 'ok', response: dashboardHeaderExample },
    {
      name: 'one-contributor-failed',
      response: {
        tiles: [dashboardHeaderExample.tiles[0]!],
        // The page renders what it has; it never invents a zero.
        degraded: ['storage'],
        generatedAt: '2026-09-22T09:00:00+08:00',
      },
    },
  ],
});
