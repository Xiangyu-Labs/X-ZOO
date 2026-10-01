'use client';

import { Button } from 'antd';
import {
  userGroupCreate,
  userGroupDelete,
  userGroupList,
  userGroupUpdate,
} from '@shop/contracts/user/user.taxonomy.contract';
import { userGroupForm, type UserGroup } from '@shop/contracts/user/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

/**
 * 用户分组 — a short operator-maintained list.
 *
 * Deleting a group drops its memberships and leaves the customers alone, which
 * the confirmation says out loud: deleted silently, operators would assume the
 * customers went with it.
 */
export function UserGroupsPage() {
  const modal = useFormModal<UserGroup>();

  return (
    <PageContainer subTitle="给用户分组，用在列表筛选和后续的营销圈选">
      <CrudTable
        route={userGroupList}
        toolbar={
          <Can permission="user:group:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建分组
            </Button>
          </Can>
        }
        columns={[
          idColumn<UserGroup>({ sortable: true }),
          textColumn<UserGroup>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          {
            title: '用户数',
            dataIndex: 'memberCount',
            key: 'memberCount',
            width: 100,
            align: 'right' as const,
          },
          {
            title: '排序',
            dataIndex: 'sortOrder',
            key: 'sortOrder',
            width: 90,
            align: 'right' as const,
            sorter: true,
            showSorterTooltip: false,
          },
          instantColumn<UserGroup>({ title: '创建时间', dataIndex: 'createdAt', sortable: false }),
          actionsColumn<UserGroup>({
            width: 150,
            render: (row) => (
              <>
                <Can permission="user:group:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={userGroupDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除分组「${row.name}」？`}
                  description="该分组下的用户会失去这个分组，用户本身不受影响。"
                  invalidate={[userGroupList]}
                  successMessage="已删除"
                  permission="user:group:write"
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
        title={modal.record ? '编辑分组' : '新建分组'}
        schema={userGroupForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', maxLength: 64 },
          { kind: 'number', name: 'sortOrder', label: '排序', min: 0, max: 9999, help: '小的在前' },
        ]}
        initialValues={modal.record}
        route={modal.record ? userGroupUpdate : userGroupCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[userGroupList]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}
