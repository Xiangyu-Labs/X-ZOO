'use client';

import { Button, Tabs, Tag } from 'antd';
import { useState } from 'react';
import {
  catalogAdminLabelCategoryCreate,
  catalogAdminLabelCategoryDelete,
  catalogAdminLabelCategoryList,
  catalogAdminLabelCategoryUpdate,
  catalogAdminLabelCreate,
  catalogAdminLabelDelete,
  catalogAdminLabelList,
  catalogAdminLabelSetEnabled,
  catalogAdminLabelUpdate,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import {
  productLabelCategoryForm,
  productLabelForm,
  type ProductLabel,
  type ProductLabelCategory,
} from '@shop/contracts/catalog/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

import {
  BOOL_OPTIONS,
  PRODUCT_LABEL_STYLE,
  labelCategoryFields,
  labelFields,
} from '../catalog-enums';

/**
 * 商品标签 and 标签分类, two tabs on one page.
 *
 * They are one screen because a label is worthless without its category and
 * the categories are a handful of rows — a separate menu entry for five names
 * is the kind of navigation that makes a console too wide. The second
 * table carries a `urlPrefix` so both can keep their own page and filters in
 * the URL at once.
 *
 * Note this is the *product* label, not the customer label: a product that
 * pointed at the user-label table is how a shop ends up tagging shirts as
 * "高价值客户".
 */
export function ProductLabelsPage() {
  const [tab, setTab] = useState<'labels' | 'categories'>('labels');

  return (
    <PageContainer
      subTitle="前台商品卡片上的角标；分类只是后台的归类，不会展示给买家"
      tabs={
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as 'labels' | 'categories')}
          items={[
            { key: 'labels', label: '商品标签' },
            { key: 'categories', label: '标签分类' },
          ]}
        />
      }
    >
      {tab === 'labels' ? <LabelsTable /> : <LabelCategoriesTable />}
    </PageContainer>
  );
}

function LabelsTable() {
  const modal = useFormModal<ProductLabel>();

  // 100 is the whole list in every shop that has ever existed; the picker is a
  // select, not a search.
  const categories = useRouteQuery(catalogAdminLabelCategoryList, {
    query: { page: 1, pageSize: 100 },
  });
  const categoryOptions = (categories.data?.items ?? []).map((row) => ({
    label: row.name,
    value: row.id,
  }));

  const setEnabled = useRouteMutation(catalogAdminLabelSetEnabled, {
    invalidate: [catalogAdminLabelList],
    successMessage: '已更新状态',
  });

  return (
    <>
      <CrudTable
        route={catalogAdminLabelList}
        scrollX={1200}
        filters={[
          { kind: 'text', name: 'keyword', label: '标签名称' },
          {
            kind: 'select',
            name: 'categoryId',
            label: '标签分类',
            options: categoryOptions,
          },
          { kind: 'select', name: 'isEnabled', label: '状态', options: BOOL_OPTIONS },
        ]}
        toolbar={
          <Can permission="catalog:label:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建标签
            </Button>
          </Can>
        }
        columns={[
          idColumn<ProductLabel>({ sortable: true }),
          {
            title: '标签',
            key: 'preview',
            width: 160,
            render: (_value: unknown, row: ProductLabel) => <LabelPreview label={row} />,
          },
          textColumn<ProductLabel>({ title: '名称', dataIndex: 'name', sortable: true }),
          textColumn<ProductLabel>({
            title: '标签分类',
            dataIndex: 'categoryName',
            placeholder: '未分类',
          }),
          {
            title: '展示形式',
            key: 'style',
            width: 100,
            render: (_value: unknown, row: ProductLabel) => (
              <StatusTag value={row.style} map={PRODUCT_LABEL_STYLE} />
            ),
          },
          {
            title: '商品数',
            key: 'productCount',
            width: 90,
            align: 'right' as const,
            render: (_value: unknown, row: ProductLabel) => row.productCount,
          },
          {
            title: '状态',
            key: 'isEnabled',
            width: 90,
            render: (_value: unknown, row: ProductLabel) => (
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
            render: (_value: unknown, row: ProductLabel) => row.sortOrder,
          },
          instantColumn<ProductLabel>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<ProductLabel>({
            width: 200,
            render: (row) => (
              <>
                <Can permission="catalog:label:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    loading={setEnabled.isPending}
                    onClick={() =>
                      setEnabled.mutate({
                        params: { id: row.id },
                        body: { isEnabled: !row.isEnabled },
                      })
                    }
                  >
                    {row.isEnabled ? '停用' : '启用'}
                  </Button>
                </Can>
                <ConfirmButton
                  route={catalogAdminLabelDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除标签「${row.name}」？`}
                  description="仍有商品在用时会被拒绝，先停用或解除绑定。"
                  invalidate={[catalogAdminLabelList]}
                  successMessage="已删除"
                  permission="catalog:label:write"
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
        title={modal.record ? `编辑标签：${modal.record.name}` : '新建标签'}
        columns={2}
        schema={productLabelForm}
        fields={labelFields(categoryOptions)}
        initialValues={modal.record ? labelValuesOf(modal.record) : undefined}
        route={modal.record ? catalogAdminLabelUpdate : catalogAdminLabelCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[catalogAdminLabelList]}
        successMessage="已保存"
      />
    </>
  );
}

/** The label as the storefront draws it, so an operator can see the colours. */
function LabelPreview({ label }: { label: ProductLabel }) {
  if (label.style === 'image') {
    return label.imageUrl ? (
      <img src={label.imageUrl} alt={label.name} style={{ height: 22, display: 'block' }} />
    ) : (
      <Tag color="error" bordered={false}>
        缺图片
      </Tag>
    );
  }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 3,
        fontSize: 12,
        lineHeight: '18px',
        color: label.fontColor ?? undefined,
        background: label.backgroundColor ?? undefined,
        border: `1px solid ${label.borderColor ?? 'var(--ant-color-border)'}`,
      }}
    >
      {label.name}
    </span>
  );
}

function labelValuesOf(row: ProductLabel) {
  return {
    categoryId: row.categoryId,
    name: row.name,
    style: row.style,
    ...(row.fontColor === null ? {} : { fontColor: row.fontColor }),
    ...(row.backgroundColor === null ? {} : { backgroundColor: row.backgroundColor }),
    ...(row.borderColor === null ? {} : { borderColor: row.borderColor }),
    ...(row.imageUrl === null ? {} : { imageUrl: row.imageUrl }),
    isVisible: row.isVisible,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
  };
}

function LabelCategoriesTable() {
  const modal = useFormModal<ProductLabelCategory>();

  return (
    <>
      <CrudTable
        route={catalogAdminLabelCategoryList}
        urlPrefix="lc"
        scrollX={800}
        filters={[{ kind: 'text', name: 'keyword', label: '分类名称' }]}
        toolbar={
          <Can permission="catalog:label:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建标签分类
            </Button>
          </Can>
        }
        columns={[
          idColumn<ProductLabelCategory>({ sortable: true }),
          textColumn<ProductLabelCategory>({ title: '名称', dataIndex: 'name', sortable: true }),
          {
            title: '标签数',
            key: 'labelCount',
            width: 100,
            align: 'right' as const,
            render: (_value: unknown, row: ProductLabelCategory) => row.labelCount,
          },
          {
            title: '排序',
            key: 'sortOrder',
            width: 80,
            sorter: true,
            align: 'right' as const,
            render: (_value: unknown, row: ProductLabelCategory) => row.sortOrder,
          },
          instantColumn<ProductLabelCategory>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<ProductLabelCategory>({
            width: 150,
            render: (row) => (
              <>
                <Can permission="catalog:label:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={catalogAdminLabelCategoryDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除标签分类「${row.name}」？`}
                  description="分类下仍有标签时会被拒绝。"
                  invalidate={[catalogAdminLabelCategoryList, catalogAdminLabelList]}
                  successMessage="已删除"
                  permission="catalog:label:write"
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
        title={modal.record ? `编辑标签分类：${modal.record.name}` : '新建标签分类'}
        size="small"
        columns={2}
        schema={productLabelCategoryForm}
        fields={labelCategoryFields}
        initialValues={
          modal.record ? { name: modal.record.name, sortOrder: modal.record.sortOrder } : undefined
        }
        route={modal.record ? catalogAdminLabelCategoryUpdate : catalogAdminLabelCategoryCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[catalogAdminLabelCategoryList, catalogAdminLabelList]}
        successMessage="已保存"
      />
    </>
  );
}
