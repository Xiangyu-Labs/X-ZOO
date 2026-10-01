'use client';

import { Button, Typography, message } from 'antd';
import {
  systemRoleCreate,
  systemRoleDelete,
  systemRoleDetail,
  systemRoleList,
  systemRoleSetStatus,
  systemRoleUpdate,
} from '@shop/contracts/system/system.role.contract';
import {
  roleForm,
  type RoleDetail,
  type RoleForm,
  type RoleListItem,
} from '@shop/contracts/system/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import type { FieldSpec } from '@/admin/kit/form/types';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { StatusToggleButton } from '@/admin/kit/status-toggle-button';
import { Can } from '@/admin/session/can';

import { PermissionPicker } from './permission-picker';

const ENABLED = {
  true: { label: '启用', color: 'success' },
  false: { label: '停用', color: 'default' },
} as const;

/**
 * 身份管理 (roles).
 *
 * Editing a role's grants, or disabling it, ends the sessions of every admin
 * holding it — a cached permission list is exactly how a revoked grant keeps
 * working for another hour. The page says so rather than letting it surprise
 * somebody.
 *
 * The permission list is not loaded with the row: a role's atoms come from
 * `systemRoleDetail`, so opening the editor fetches them fresh (including the
 * 已失效 ones the tree no longer declares).
 */
export function RolesPage() {
  // The form mounts only once the detail has arrived: seeded from an empty
  // read, a save would blank the name and revoke every grant.
  const modal = useFormModal<RoleListItem, typeof systemRoleDetail>({
    detail: {
      route: systemRoleDetail,
      params: (row) => ({ id: row.id }),
      select: formValuesOf,
    },
  });
  const editing = modal.record;

  // The same request the form loads (one cache entry); the picker also needs
  // the 已失效 atoms, which are not a form value. The dialog reports a failure.
  const detail = useRouteQuery(
    systemRoleDetail,
    editing ? { params: { id: editing.id } } : undefined,
    { enabled: editing !== undefined, presentError: false },
  );

  const fields: FieldSpec<keyof RoleForm & string>[] = [
    { kind: 'text', name: 'name', label: '身份名称', span: 24 },
    { kind: 'text', name: 'remark', label: '备注', span: 24 },
    {
      kind: 'switch',
      name: 'enabled',
      label: '状态',
      checkedText: '启用',
      uncheckedText: '停用',
      help: '停用后，持有该身份的管理员会被强制重新登录',
      span: 24,
    },
    {
      kind: 'custom',
      name: 'permissions',
      label: '权限',
      span: 24,
      render: ({ value, onChange }) => (
        <PermissionPicker
          value={value as string[] | undefined}
          onChange={onChange}
          unknownPermissions={detail.data?.unknownPermissions ?? []}
        />
      ),
    },
  ];

  return (
    <PageContainer subTitle="一个身份就是一组权限；修改权限或停用身份会让持有者重新登录">
      <CrudTable
        route={systemRoleList}
        filters={[
          { kind: 'text', name: 'keyword', label: '名称' },
          {
            kind: 'select',
            name: 'enabled',
            label: '状态',
            options: [
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ],
          },
        ]}
        toolbar={
          <Can permission="system:role:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建身份
            </Button>
          </Can>
        }
        columns={[
          idColumn<RoleListItem>({ sortable: true }),
          textColumn<RoleListItem>({ title: '名称', dataIndex: 'name', sortable: true }),
          textColumn<RoleListItem>({ title: '备注', dataIndex: 'remark', ellipsis: true }),
          {
            title: '管理员',
            key: 'adminCount',
            width: 100,
            render: (_value: unknown, row: RoleListItem) =>
              row.adminCount > 0 ? (
                row.adminCount
              ) : (
                <Typography.Text type="secondary">0</Typography.Text>
              ),
          },
          {
            title: '权限数',
            key: 'permissionCount',
            width: 100,
            render: (_value: unknown, row: RoleListItem) => row.permissionCount,
          },
          {
            title: '状态',
            key: 'enabled',
            width: 90,
            render: (_value: unknown, row: RoleListItem) => (
              <StatusTag value={String(row.enabled)} map={ENABLED} />
            ),
          },
          instantColumn<RoleListItem>({
            title: '创建时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<RoleListItem>({
            width: 200,
            render: (row) => (
              <>
                <Can permission="system:role:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <StatusToggleButton
                    route={systemRoleSetStatus}
                    on={row.enabled}
                    input={(next) => ({ params: { id: row.id }, body: { enabled: next } })}
                    confirmTitle={`停用身份「${row.name}」？`}
                    confirmDescription="停用后，持有这个身份的管理员会失去它的权限。"
                    invalidate={[systemRoleList]}
                  />
                </Can>
                <ConfirmButton
                  route={systemRoleDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除身份「${row.name}」？`}
                  description={
                    row.adminCount > 0
                      ? `还有 ${row.adminCount} 位管理员持有该身份，需要先解除才能删除。`
                      : undefined
                  }
                  invalidate={[systemRoleList]}
                  successMessage="已删除"
                  permission="system:role:delete"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...modal.props}
        title={editing ? `编辑身份：${editing.name}` : '新建身份'}
        size="large"
        schema={roleForm}
        fields={fields}
        // A fresh form per record, so nothing of the previous role lingers.
        key={editing?.id ?? 'new'}
        initialValues={editing ? undefined : { enabled: true, permissions: [] }}
        route={editing ? systemRoleUpdate : systemRoleCreate}
        toInput={(values) =>
          editing ? { params: { id: editing.id }, body: values } : { body: values }
        }
        invalidate={[systemRoleList]}
        onSuccess={() => {
          void message.success(editing ? '已保存，持有该身份的管理员需要重新登录' : '已创建');
        }}
      />
    </PageContainer>
  );
}

/** The detail as the form's values; a `null` remark is an absent key. */
function formValuesOf(role: RoleDetail) {
  return {
    name: role.name,
    ...(role.remark === null ? {} : { remark: role.remark }),
    enabled: role.enabled,
    permissions: role.permissions,
  };
}
