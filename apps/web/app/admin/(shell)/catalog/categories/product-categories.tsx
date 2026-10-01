'use client';

import { Button, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import {
  catalogAdminCategoryCreate,
  catalogAdminCategoryDelete,
  catalogAdminCategoryList,
  catalogAdminCategorySetVisibility,
  catalogAdminCategoryTree,
  catalogAdminCategoryUpdate,
} from '@shop/contracts/catalog/catalog.category.admin.contract';
import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import { productCategoryForm, type ProductCategory } from '@shop/contracts/catalog/schemas';

import { useRouteMutation } from '@/admin/api/hooks';
import { routeKeyPrefix } from '@/admin/api/query-keys';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import {
  actionsColumn,
  idColumn,
  imageColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

import { BOOL_OPTIONS, CATEGORY_TREE_CACHE_KEY, categoryFields } from '../catalog-enums';

/**
 * 商品分类.
 *
 * A flat, filterable list rather than an expandable tree table: the contract
 * caps the tree at three levels, the `path` column already says where a row
 * sits, and a list is the only shape that can be searched, sorted and paged.
 * Drilling down is a filter (`parentId`), which the 下级 link sets — so "show me
 * what is under 男装" is a URL you can send someone.
 */
export function ProductCategoriesPage() {
  const modal = useFormModal<ProductCategory>();
  const queryClient = useQueryClient();

  // Every category write changes the tree the pickers cache — this page's own
  // `parentId` picker included — so the cached tree goes with it.
  const invalidateTree = (): void => {
    void queryClient.invalidateQueries({ queryKey: routeKeyPrefix(catalogAdminCategoryTree) });
    void queryClient.invalidateQueries({ queryKey: ['kit.treeSelect', CATEGORY_TREE_CACHE_KEY] });
  };

  const setVisibility = useRouteMutation(catalogAdminCategorySetVisibility, {
    invalidate: [catalogAdminCategoryList],
    successMessage: '已更新显示状态',
    onSuccess: invalidateTree,
  });

  return (
    <PageContainer subTitle="最多三级；隐藏分类仍可被商品引用，只是前台不展示">
      <CrudTable
        route={catalogAdminCategoryList}
        scrollX={1100}
        filters={[
          { kind: 'text', name: 'keyword', label: '分类名称' },
          {
            kind: 'select',
            name: 'level',
            label: '层级',
            options: [
              { label: '一级', value: '0' },
              { label: '二级', value: '1' },
              { label: '三级', value: '2' },
            ],
          },
          { kind: 'select', name: 'isVisible', label: '前台显示', options: BOOL_OPTIONS },
          { kind: 'text', name: 'parentId', label: '上级分类 ID' },
        ]}
        toolbar={
          <Can permission="catalog:category:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建分类
            </Button>
          </Can>
        }
        columns={[
          idColumn<ProductCategory>({ sortable: true }),
          imageColumn<ProductCategory>({ title: '图标', dataIndex: 'iconUrl' }),
          textColumn<ProductCategory>({
            title: '分类名称',
            dataIndex: 'name',
            ellipsis: true,
            sortable: true,
          }),
          {
            title: '层级',
            key: 'level',
            width: 90,
            render: (_value: unknown, row: ProductCategory) => (
              <Typography.Text>{`${row.level + 1} 级`}</Typography.Text>
            ),
          },
          textColumn<ProductCategory>({ title: '路径', dataIndex: 'path', width: 140 }),
          {
            title: '商品数',
            key: 'productCount',
            width: 90,
            align: 'right' as const,
            render: (_value: unknown, row: ProductCategory) => row.productCount,
          },
          {
            title: '前台显示',
            key: 'isVisible',
            width: 100,
            render: (_value: unknown, row: ProductCategory) => (
              <Typography.Text type={row.isVisible ? 'success' : 'secondary'}>
                {row.isVisible ? '显示' : '隐藏'}
              </Typography.Text>
            ),
          },
          {
            title: '排序',
            key: 'sortOrder',
            width: 80,
            sorter: true,
            align: 'right' as const,
            render: (_value: unknown, row: ProductCategory) => row.sortOrder,
          },
          instantColumn<ProductCategory>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<ProductCategory>({
            width: 220,
            render: (row) => (
              <>
                <Can permission="catalog:category:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    loading={setVisibility.isPending}
                    onClick={() =>
                      setVisibility.mutate({
                        params: { id: row.id },
                        body: { isVisible: !row.isVisible },
                      })
                    }
                  >
                    {row.isVisible ? '隐藏' : '显示'}
                  </Button>
                </Can>
                <ConfirmButton
                  route={catalogAdminCategoryDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除分类「${row.name}」？`}
                  description="有子分类或仍有商品在用时会被拒绝，先移走再删。"
                  invalidate={[catalogAdminCategoryList]}
                  successMessage="已删除"
                  onSuccess={invalidateTree}
                  permission="catalog:category:write"
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
        title={modal.record ? `编辑分类：${modal.record.name}` : '新建分类'}
        columns={2}
        schema={productCategoryForm}
        fields={categoryFields}
        initialValues={modal.record ? initialValuesOf(modal.record) : undefined}
        route={modal.record ? catalogAdminCategoryUpdate : catalogAdminCategoryCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[catalogAdminCategoryList, catalogAdminProductList]}
        successMessage="已保存"
        onSuccess={invalidateTree}
      />
    </PageContainer>
  );
}

/**
 * The row minus the fields the form does not own, with `null` turned into
 * `undefined` where the contract says optional: `exactOptionalPropertyTypes`
 * means an optional field is either absent or a real value, never `null`.
 * `parentId` is the exception — `null` is a legal value there, and it means
 * "a root category".
 */
function initialValuesOf(row: ProductCategory) {
  return {
    parentId: row.parentId,
    name: row.name,
    ...(row.iconUrl === null ? {} : { iconUrl: row.iconUrl }),
    ...(row.bannerUrl === null ? {} : { bannerUrl: row.bannerUrl }),
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
  };
}
