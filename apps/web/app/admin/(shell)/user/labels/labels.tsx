'use client';

import { Button, Tabs } from 'antd';
import { useState } from 'react';
import {
  userLabelCategoryCreate,
  userLabelCategoryDelete,
  userLabelCategoryList,
  userLabelCategoryUpdate,
  userLabelCreate,
  userLabelDelete,
  userLabelList,
  userLabelUpdate,
} from '@shop/contracts/user/user.taxonomy.contract';
import {
  userLabelCategoryForm,
  userLabelForm,
  type UserLabel,
  type UserLabelCategory,
} from '@shop/contracts/user/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

/**
 * 用户标签 and their categories, on one screen.
 *
 * They are one screen because they are one job: nobody maintains categories
 * without maintaining labels, which is why the contract gives both the
 * `user:label:*` atoms rather than inventing a third pair nobody would grant.
 *
 * A label name is unique shop-wide, not per category — 母婴 under two
 * categories means an operator filtering by it gets half the customers.
 */
export function UserLabelsPage() {
  const [tab, setTab] = useState('labels');

  return (
    <PageContainer
      subTitle="标签用于用户列表筛选与批量圈选；标签名全站唯一"
      tabs={
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'labels', label: '标签' },
            { key: 'categories', label: '标签分类' },
          ]}
        />
      }
    >
      {tab === 'labels' ? <LabelsTable /> : <CategoriesTable />}
    </PageContainer>
  );
}

function LabelsTable() {
  const modal = useFormModal<UserLabel>();
  const categories = useRouteQuery(userLabelCategoryList, { query: { page: 1, pageSize: 100 } });
  const categoryOptions = (categories.data?.items ?? []).map((category) => ({
    value: category.id,
    label: category.name,
  }));

  return (
    <>
      <CrudTable
        route={userLabelList}
        urlPrefix="label"
        toolbar={
          <Can permission="user:label:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建标签
            </Button>
          </Can>
        }
        filters={[
          { kind: 'text', name: 'keyword', label: '名称' },
          { kind: 'select', name: 'categoryId', label: '分类', options: categoryOptions },
        ]}
        columns={[
          idColumn<UserLabel>({ sortable: true }),
          textColumn<UserLabel>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          textColumn<UserLabel>({
            title: '分类',
            dataIndex: 'categoryName',
            placeholder: '未分类',
          }),
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
          instantColumn<UserLabel>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<UserLabel>({
            width: 150,
            render: (row) => (
              <>
                <Can permission="user:label:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={userLabelDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除标签「${row.name}」？`}
                  description="打了这个标签的用户会失去它，用户本身不受影响。"
                  invalidate={[userLabelList]}
                  successMessage="已删除"
                  permission="user:label:write"
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
        title={modal.record ? '编辑标签' : '新建标签'}
        schema={userLabelForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', maxLength: 64 },
          {
            kind: 'select',
            name: 'categoryId',
            label: '分类',
            options: categoryOptions,
            required: false,
            help: '可以不选，未分类的标签照样能用',
          },
          { kind: 'number', name: 'sortOrder', label: '排序', min: 0, max: 9999, help: '小的在前' },
        ]}
        initialValues={modal.record}
        route={modal.record ? userLabelUpdate : userLabelCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[userLabelList]}
        successMessage="已保存"
      />
    </>
  );
}

function CategoriesTable() {
  const modal = useFormModal<UserLabelCategory>();

  return (
    <>
      <CrudTable
        route={userLabelCategoryList}
        urlPrefix="cat"
        toolbar={
          <Can permission="user:label:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建分类
            </Button>
          </Can>
        }
        columns={[
          idColumn<UserLabelCategory>({ sortable: true }),
          textColumn<UserLabelCategory>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          {
            title: '排序',
            dataIndex: 'sortOrder',
            key: 'sortOrder',
            width: 90,
            align: 'right' as const,
            sorter: true,
            showSorterTooltip: false,
          },
          instantColumn<UserLabelCategory>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<UserLabelCategory>({
            width: 150,
            render: (row) => (
              <>
                <Can permission="user:label:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={userLabelCategoryDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除分类「${row.name}」？`}
                  description="分类下的标签不会被删除，只是变成未分类。"
                  invalidate={[userLabelCategoryList, userLabelList]}
                  successMessage="已删除"
                  permission="user:label:write"
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
        title={modal.record ? '编辑分类' : '新建分类'}
        schema={userLabelCategoryForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', maxLength: 64 },
          { kind: 'number', name: 'sortOrder', label: '排序', min: 0, max: 9999, help: '小的在前' },
        ]}
        initialValues={modal.record}
        route={modal.record ? userLabelCategoryUpdate : userLabelCategoryCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[userLabelCategoryList, userLabelList]}
        successMessage="已保存"
      />
    </>
  );
}
