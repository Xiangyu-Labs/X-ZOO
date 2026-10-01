'use client';

import { Button, Space, Switch, Table, Typography } from 'antd';
import {
  cmsArticleList,
  cmsCategoryCreate,
  cmsCategoryDelete,
  cmsCategoryList,
  cmsCategorySetStatus,
  cmsCategoryUpdate,
} from '@shop/contracts/cms/cms.admin.contract';
import { articleCategoryForm, type ArticleCategory } from '@shop/contracts/cms/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { TableToolbar } from '@/admin/kit/table/crud-table';
import { statusOptions, StatusTag } from '@/admin/kit/status-tag';
import { Can } from '@/admin/session/can';

import { ARTICLE_CATEGORY_STATUS } from '../cms-enums';

/**
 * 文章分类.
 *
 * A plain `Table`, not `CrudTable`: the route answers the whole tree in one
 * unpaged response and the rows arrive already depth-first, so there is no
 * paging, no sorting and nothing for the crud shell to do. The indent is the
 * row's own `depth`, which the server computed — the client never re-derives
 * the tree.
 *
 * 隐藏 is the safe retirement: hiding a parent takes its children off the
 * storefront with it, while deleting is refused until the category is empty.
 */
export function ArticleCategoriesPage() {
  const modal = useFormModal<ArticleCategory>();
  const list = useRouteQuery(cmsCategoryList, { query: {} });

  const setStatus = useRouteMutation(cmsCategorySetStatus, {
    invalidate: [cmsCategoryList],
    successMessage: '已更新状态',
  });

  const parents = (list.data?.items ?? []).filter((item) => item.depth === 0);

  return (
    <PageContainer subTitle="最多两级；前台的文章分类导航按这里的排序显示">
      <TableToolbar onRefresh={() => list.refetch()} refreshing={list.isFetching}>
        <Can permission="cms:category:write">
          <Button type="primary" onClick={() => modal.show()}>
            新建分类
          </Button>
        </Can>
      </TableToolbar>
      <Table<ArticleCategory>
        rowKey="id"
        loading={list.isPending}
        dataSource={list.data?.items ?? []}
        pagination={false}
        size="middle"
        columns={[
          {
            title: '分类名称',
            key: 'title',
            render: (_value: unknown, row) => (
              <span style={{ paddingLeft: row.depth * 24 }}>
                {row.depth === 1 ? <Typography.Text type="secondary">└ </Typography.Text> : null}
                {row.title}
              </span>
            ),
          },
          { title: '简介', dataIndex: 'intro', key: 'intro', ellipsis: true },
          {
            title: '已发布文章',
            dataIndex: 'articleCount',
            key: 'articleCount',
            width: 110,
          },
          { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 90 },
          {
            title: '前台显示',
            key: 'status',
            width: 110,
            render: (_value: unknown, row) => (
              <Can
                permission="cms:category:write"
                fallback={<StatusTag value={row.status} map={ARTICLE_CATEGORY_STATUS} />}
              >
                <Switch
                  size="small"
                  checked={row.status === 'visible'}
                  loading={setStatus.isPending && setStatus.variables?.params?.id === row.id}
                  onChange={(checked) =>
                    setStatus.mutate({
                      params: { id: row.id },
                      body: { status: checked ? 'visible' : 'hidden' },
                    })
                  }
                />
              </Can>
            ),
          },
          {
            title: '操作',
            key: 'actions',
            width: 160,
            render: (_value: unknown, row) => (
              <Space size={0}>
                <Can permission="cms:category:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={cmsCategoryDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除分类「${row.title}」？`}
                  description="还有子分类或文章时无法删除，改用隐藏。"
                  invalidate={[cmsCategoryList, cmsArticleList]}
                  successMessage="已删除"
                  permission="cms:category:write"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </Space>
            ),
          },
        ]}
      />

      <ModalForm
        {...modal.props}
        title={modal.record ? '编辑文章分类' : '新建文章分类'}
        schema={articleCategoryForm}
        fields={[
          { kind: 'text', name: 'title', label: '分类名称', span: 24, maxLength: 100 },
          {
            kind: 'select',
            name: 'parentId',
            label: '上级分类',
            span: 12,
            allowClear: true,
            placeholder: '不选则为一级分类',
            help: '分类树最多两级，已有子分类的分类不能再挂到别人下面',
            options: parents
              .filter((item) => item.id !== modal.record?.id)
              .map((item) => ({ value: item.id, label: item.title })),
          },
          { kind: 'number', name: 'sortOrder', label: '排序', span: 12, min: 0, max: 9999 },
          { kind: 'textarea', name: 'intro', label: '简介', span: 24, rows: 2, maxLength: 255 },
          { kind: 'asset', name: 'imageUrl', label: '分类图片', span: 12 },
          {
            kind: 'radio',
            name: 'status',
            label: '前台显示',
            span: 12,
            optionType: 'button',
            options: statusOptions(ARTICLE_CATEGORY_STATUS),
          },
        ]}
        initialValues={modal.record ?? { status: 'visible', sortOrder: 0, parentId: null }}
        route={modal.record ? cmsCategoryUpdate : cmsCategoryCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[cmsCategoryList, cmsArticleList]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}
