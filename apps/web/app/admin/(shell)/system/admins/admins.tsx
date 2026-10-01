'use client';

import { Button, Tag, Typography, message } from 'antd';
import { useState } from 'react';
import {
  systemAdminCreate,
  systemAdminDelete,
  systemAdminList,
  systemAdminResetPassword,
  systemAdminSetStatus,
  systemAdminUpdate,
} from '@shop/contracts/system/system.admin.contract';
import { systemRoleList } from '@shop/contracts/system/system.role.contract';
import {
  adminForm,
  adminPasswordBody,
  type AdminForm,
  type AdminListItem,
} from '@shop/contracts/system/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ConfirmAction } from '@/admin/kit/confirm-action';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import type { FieldSpec } from '@/admin/kit/form/types';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';
import { useCan } from '@/admin/session/session-provider';

const ENABLED = {
  true: { label: '启用', color: 'success' },
  false: { label: '停用', color: 'default' },
} as const;

/**
 * 管理员.
 *
 * Two things here are not cosmetic. Disabling an account or resetting its
 * password kills that account's live sessions, and the route says how many —
 * showing the number is the only way an operator can tell a stuck session from
 * a revoked one. And the last enabled super admin cannot be disabled or
 * deleted; the server refuses, the page just relays the message.
 */
export function AdminsPage() {
  const modal = useFormModal<AdminListItem>();
  const [resetting, setResetting] = useState<AdminListItem | null>(null);

  // A role that may manage admins but not read roles gets no options rather
  // than a 403 toast on every visit.
  const mayReadRoles = useCan()('system:role:read');
  const roles = useRouteQuery(
    systemRoleList,
    { query: { page: 1, pageSize: 100 } },
    { enabled: mayReadRoles },
  );
  const roleOptions = (roles.data?.items ?? []).map((role) => ({
    value: role.id,
    label: role.name,
  }));

  const setStatus = useRouteMutation(systemAdminSetStatus, {
    invalidate: [systemAdminList],
    onSuccess: (result) => {
      void message.success(
        result.revokedSessions > 0
          ? `已停用，注销了 ${result.revokedSessions} 个登录会话`
          : '已更新状态',
      );
    },
  });

  const fields: FieldSpec<keyof AdminForm & string>[] = [
    {
      kind: 'text',
      name: 'account',
      label: '账号',
      disabled: modal.record !== undefined,
      help: modal.record ? '账号创建后不可修改' : '字母、数字、下划线、点和横线',
    },
    { kind: 'text', name: 'name', label: '姓名' },
    {
      kind: 'password',
      name: 'password',
      label: '密码',
      required: modal.record === undefined,
      ...(modal.record ? { help: '留空表示不修改' } : {}),
    },
    { kind: 'text', name: 'phone', label: '手机号' },
    {
      kind: 'select',
      name: 'roleIds',
      label: '身份',
      mode: 'multiple',
      options: roleOptions,
      help: mayReadRoles
        ? '超级管理员不受身份限制，拥有全部权限'
        : '没有查看身份的权限，无法选择身份',
      disabled: !mayReadRoles,
      span: 24,
    },
    { kind: 'switch', name: 'enabled', label: '状态', checkedText: '启用', uncheckedText: '停用' },
  ];

  return (
    <PageContainer subTitle="后台账号与其身份；停用或改密会立刻注销该账号的所有登录">
      <CrudTable
        route={systemAdminList}
        scrollX={1200}
        filters={[
          { kind: 'text', name: 'keyword', label: '关键词', placeholder: '账号或姓名' },
          {
            kind: 'select',
            name: 'enabled',
            label: '状态',
            options: [
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ],
          },
          ...(mayReadRoles
            ? [{ kind: 'select' as const, name: 'roleId', label: '身份', options: roleOptions }]
            : []),
        ]}
        toolbar={
          <Can permission="system:admin:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建管理员
            </Button>
          </Can>
        }
        columns={[
          idColumn<AdminListItem>({ sortable: true }),
          textColumn<AdminListItem>({ title: '账号', dataIndex: 'account' }),
          textColumn<AdminListItem>({ title: '姓名', dataIndex: 'name' }),
          {
            title: '身份',
            key: 'roleNames',
            width: 220,
            render: (_value: unknown, row: AdminListItem) =>
              row.isSuper ? (
                <Tag color="gold">超级管理员</Tag>
              ) : row.roleNames.length === 0 ? (
                <Typography.Text type="secondary">未分配</Typography.Text>
              ) : (
                row.roleNames.map((name) => <Tag key={name}>{name}</Tag>)
              ),
          },
          textColumn<AdminListItem>({ title: '手机号', dataIndex: 'phone' }),
          {
            title: '状态',
            key: 'enabled',
            width: 90,
            render: (_value: unknown, row: AdminListItem) => (
              <StatusTag value={String(row.enabled)} map={ENABLED} />
            ),
          },
          instantColumn<AdminListItem>({ title: '最后登录', dataIndex: 'lastLoginAt' }),
          actionsColumn<AdminListItem>({
            width: 240,
            render: (row) => (
              <>
                <Can permission="system:admin:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <ConfirmAction
                    type="link"
                    size="small"
                    loading={setStatus.isPending && setStatus.variables?.params?.id === row.id}
                    confirm={
                      row.enabled
                        ? {
                            title: `停用管理员「${row.account}」？`,
                            description: '该账号的所有登录会话会立刻失效。',
                            okText: '停用',
                          }
                        : undefined
                    }
                    onAction={() =>
                      setStatus.mutate({
                        params: { id: row.id },
                        body: { enabled: !row.enabled },
                      })
                    }
                  >
                    {row.enabled ? '停用' : '启用'}
                  </ConfirmAction>
                  <Button type="link" size="small" onClick={() => setResetting(row)}>
                    重置密码
                  </Button>
                </Can>
                <ConfirmButton
                  route={systemAdminDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除管理员「${row.account}」？`}
                  description="该账号的登录会话会立刻失效；操作日志仍会保留。"
                  invalidate={[systemAdminList]}
                  successMessage="已删除"
                  permission="system:admin:delete"
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
        title={modal.record ? `编辑：${modal.record.account}` : '新建管理员'}
        columns={2}
        schema={adminForm}
        fields={fields}
        initialValues={modal.record ? initialValuesOf(modal.record) : undefined}
        route={modal.record ? systemAdminUpdate : systemAdminCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[systemAdminList]}
        successMessage="已保存"
      />

      <ModalForm
        open={resetting !== null}
        onClose={() => setResetting(null)}
        title={resetting ? `重置密码：${resetting.account}` : '重置密码'}
        size="small"
        schema={adminPasswordBody}
        fields={[{ kind: 'password', name: 'password', label: '新密码', span: 24 }]}
        route={systemAdminResetPassword}
        toInput={(values) => ({ params: { id: resetting?.id ?? '' }, body: values })}
        invalidate={[systemAdminList]}
        onSuccess={(result) => {
          void message.success(`密码已重置，注销了 ${result.revokedSessions} 个登录会话`);
          setResetting(null);
        }}
      />
    </PageContainer>
  );
}

/**
 * The row minus what the form does not own, with `null` turned into
 * `undefined`: `exactOptionalPropertyTypes` means an optional field is either
 * absent or a real value. `password` is deliberately never prefilled.
 */
function initialValuesOf(row: AdminListItem) {
  return {
    account: row.account,
    name: row.name,
    ...(row.phone === null ? {} : { phone: row.phone }),
    ...(row.avatar === null ? {} : { avatar: row.avatar }),
    enabled: row.enabled,
    roleIds: row.roleIds,
  };
}
