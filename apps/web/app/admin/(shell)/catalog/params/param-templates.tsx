'use client';

import { Button, Tag, Typography } from 'antd';
import {
  catalogAdminParamTemplateCreate,
  catalogAdminParamTemplateDelete,
  catalogAdminParamTemplateList,
  catalogAdminParamTemplateSetEnabled,
  catalogAdminParamTemplateUpdate,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import {
  productParamTemplateForm,
  type ProductParamTemplate,
} from '@shop/contracts/catalog/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { StatusToggleButton } from '@/admin/kit/status-toggle-button';
import { Can } from '@/admin/session/can';

import { BOOL_OPTIONS, paramTemplateFields } from '../catalog-enums';

/**
 * 商品参数.
 *
 * A template is only a suggestion: the editor copies name and value onto the
 * product, so renaming a template later does not silently rewrite the spec
 * sheet of every product that ever used it. Deleting one does not either —
 * which is why there is no "商品数" column here to be wrong.
 */
export function ParamTemplatesPage() {
  const modal = useFormModal<ProductParamTemplate>();

  return (
    <PageContainer subTitle="编辑商品时可一键带入的参数模板；停用只影响新商品，已填写的参数不变">
      <CrudTable
        route={catalogAdminParamTemplateList}
        scrollX={1000}
        filters={[
          { kind: 'text', name: 'keyword', label: '参数名称' },
          { kind: 'select', name: 'isEnabled', label: '状态', options: BOOL_OPTIONS },
        ]}
        toolbar={
          <Can permission="catalog:param:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建参数
            </Button>
          </Can>
        }
        columns={[
          idColumn<ProductParamTemplate>({ sortable: true }),
          textColumn<ProductParamTemplate>({
            title: '参数名称',
            dataIndex: 'name',
            sortable: true,
          }),
          {
            title: '可选值',
            key: 'suggestedValues',
            render: (_value: unknown, row: ProductParamTemplate) => (
              <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                {row.suggestedValues?.trim() ? row.suggestedValues : '自由填写'}
              </Typography.Text>
            ),
          },
          {
            title: '状态',
            key: 'isEnabled',
            width: 90,
            render: (_value: unknown, row: ProductParamTemplate) => (
              <Tag color={row.isEnabled ? 'success' : 'default'} bordered={false}>
                {row.isEnabled ? '启用' : '停用'}
              </Tag>
            ),
          },
          {
            title: '排序',
            key: 'sortOrder',
            width: 80,
            sorter: true,
            align: 'right' as const,
            render: (_value: unknown, row: ProductParamTemplate) => row.sortOrder,
          },
          instantColumn<ProductParamTemplate>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<ProductParamTemplate>({
            width: 200,
            render: (row) => (
              <>
                <Can permission="catalog:param:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <StatusToggleButton
                    route={catalogAdminParamTemplateSetEnabled}
                    on={row.isEnabled}
                    input={(next) => ({ params: { id: row.id }, body: { isEnabled: next } })}
                    confirmTitle={`停用参数模板「${row.name}」？`}
                    invalidate={[catalogAdminParamTemplateList]}
                  />
                </Can>
                <ConfirmButton
                  route={catalogAdminParamTemplateDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除参数模板「${row.name}」？`}
                  description="已填写到商品上的参数不受影响。"
                  invalidate={[catalogAdminParamTemplateList]}
                  successMessage="已删除"
                  permission="catalog:param:write"
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
        title={modal.record ? `编辑参数：${modal.record.name}` : '新建参数'}
        schema={productParamTemplateForm}
        fields={paramTemplateFields}
        initialValues={
          modal.record
            ? {
                name: modal.record.name,
                ...(modal.record.suggestedValues === null
                  ? {}
                  : { suggestedValues: modal.record.suggestedValues }),
                isEnabled: modal.record.isEnabled,
                sortOrder: modal.record.sortOrder,
              }
            : undefined
        }
        route={modal.record ? catalogAdminParamTemplateUpdate : catalogAdminParamTemplateCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[catalogAdminParamTemplateList]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}
