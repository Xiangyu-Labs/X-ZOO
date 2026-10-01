'use client';

import { Alert, Skeleton, Space, Typography } from 'antd';
import { useSearchParams } from 'next/navigation';
import {
  systemConfigGet,
  systemConfigGroupList,
  systemConfigSave,
  systemConfigTest,
} from '@shop/contracts/system/system.settings.contract';

import { errorMessage } from '@/admin/api/errors';
import { useRouteQuery } from '@/admin/api/hooks';
import { ConfigGroupForm } from '@/admin/kit/config/config-group-form';
import type { ConfigFieldDescriptor, ConfigValues } from '@/admin/kit/config/types';
import { InstantText } from '@/admin/kit/instant-text';
import { PageContainer } from '@/admin/kit/page-container';
import { useCan } from '@/admin/session/session-provider';

import { AppearancePreview } from './appearance-preview';
import { MiniTradePanel } from './mini-trade-panel';

/** Groups whose screen carries an action beside the form. */
const PANELS: Record<string, () => React.ReactNode> = {
  'wechat-mini-trade': () => <MiniTradePanel />,
};

/** Groups with a live preview beside the form, fed the values on the screen. */
const PREVIEWS: Record<string, (values: ConfigValues) => React.ReactNode> = {
  'storefront-appearance': (values) => <AppearancePreview values={values} />,
};

/**
 * One settings screen, for every config group there is.
 *
 * The 575-key `sys_config` table and its hand-built screens are replaced by
 * this: the server sends a descriptor, the kit renders it, the same route saves
 * it. Adding a setting is a line in a `*.config.ts`, not a page.
 *
 * Secrets never arrive here. A `password` field's value in `values` is a
 * boolean "is set" flag, and the form only sends that key when the operator
 * typed a new value — so saving the site name cannot blank out a credential.
 */
export function SettingsGroupPage({ group }: { group: string }) {
  const input = { params: { group } };
  // Set by the settings search: which field to scroll to.
  const focusKey = useSearchParams().get('field') ?? undefined;
  // Reading a group is `system:config:read`; saving and 测试 are both
  // `system:config:write` *and* the group's own write atom (支付 is
  // `payment:config:write`). A reader gets the form read-only, with no 保存 or
  // 测试 to press into a 403.
  const can = useCan();
  const { data, isPending, error } = useRouteQuery(systemConfigGet, input, {
    presentError: false,
  });

  if (isPending) {
    return (
      <PageContainer>
        <Skeleton active paragraph={{ rows: 8 }} />
      </PageContainer>
    );
  }

  if (error || !data) {
    return (
      <PageContainer breadcrumb={false}>
        <Alert
          type="error"
          showIcon
          message="打不开这个配置分组"
          description={errorMessage(error, '配置分组不存在')}
        />
      </PageContainer>
    );
  }

  const mayWrite =
    can('system:config:write') && can(groupWritePermission(data.descriptor.permission));
  const writable = mayWrite && data.descriptor.fields.length > 0;

  return (
    <PageContainer
      title={data.descriptor.title}
      breadcrumb={[
        { label: '系统设置', href: '/admin/system/settings' },
        { label: data.descriptor.title },
      ]}
      extra={
        data.updatedAt ? (
          <Typography.Text type="secondary">
            最后修改 <InstantText value={data.updatedAt} />
          </Typography.Text>
        ) : undefined
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {mayWrite ? null : (
          <Alert type="info" showIcon message="你的身份只能查看这些配置，不能在这里修改" />
        )}
        <ConfigGroupForm
          descriptor={{
            group: data.descriptor.group,
            title: data.descriptor.title,
            ...(data.descriptor.description === undefined
              ? {}
              : { description: data.descriptor.description }),
            fields: data.descriptor.fields.map(toKitField),
            ...(data.descriptor.test === undefined
              ? {}
              : {
                  test: {
                    label: data.descriptor.test.label,
                    ...(data.descriptor.test.confirm === undefined
                      ? {}
                      : { confirm: data.descriptor.test.confirm }),
                    inputs: data.descriptor.test.inputs.map(toKitField),
                    optional: data.descriptor.test.optional ?? [],
                  },
                }),
          }}
          values={data.values}
          route={systemConfigSave}
          toInput={(payload) => ({ params: { group }, body: { values: payload } })}
          invalidate={[systemConfigGet, systemConfigGroupList]}
          successMessage="已保存"
          disabled={!writable}
          testRoute={systemConfigTest}
          testInvalidate={[systemConfigGroupList]}
          aside={PREVIEWS[group]}
          focusKey={focusKey}
        />
        {PANELS[group]?.() ?? null}
      </Space>
    </PageContainer>
  );
}

/**
 * Contract descriptor → kit descriptor.
 *
 * The two shapes agree field for field, so this is a copy: the only work is
 * dropping keys that are `undefined`, which `exactOptionalPropertyTypes`
 * requires. The server sorts fields by section, and the kit renders each run
 * under its heading.
 */
function toKitField(field: {
  key: string;
  label: string;
  kind: ConfigFieldDescriptor['kind'];
  help?: string | undefined;
  placeholder?: string | undefined;
  options?: { label: string; value: string | number | boolean }[] | undefined;
  section?: string | undefined;
  multiple?: boolean | undefined;
  visibleWhen?: { key: string; equals: unknown } | undefined;
  readOnly?: boolean | undefined;
  unit?: ConfigFieldDescriptor['unit'];
}): ConfigFieldDescriptor {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    ...(field.help === undefined ? {} : { help: field.help }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.section === undefined ? {} : { section: field.section }),
    ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
    ...(field.visibleWhen === undefined ? {} : { visibleWhen: field.visibleWhen }),
    ...(field.readOnly === undefined ? {} : { readOnly: field.readOnly }),
    ...(field.unit === undefined ? {} : { unit: field.unit }),
  };
}

/**
 * The atom that writes a group, as the server derives it
 * (`config.service.ts::writePermissionFor`): `x:read` → `x:write`.
 */
export function groupWritePermission(readPermission: string): string {
  return readPermission.endsWith(':read')
    ? `${readPermission.slice(0, -':read'.length)}:write`
    : readPermission;
}
