'use client';

import { Button, Space, Tabs, Tooltip, Typography, message } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import {
  catalogAdminProductDelete,
  catalogAdminProductDetail,
  catalogAdminProductExport,
  catalogAdminProductList,
  catalogAdminProductRestore,
  catalogAdminProductSetStatus,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import type {
  AdminProductListItem,
  AdminProductTab,
  ProductExportResult,
} from '@shop/contracts/catalog/schemas';

import { useRouteMutation } from '@/admin/api/hooks';
import { ConfirmAction } from '@/admin/kit/confirm-action';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { TreeSelectField } from '@/admin/kit/form/select-fields';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { idColumn, imageColumn, instantColumn, moneyColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import type { FilterSpec } from '@/admin/kit/table/filter-bar';
import { useDetailHref } from '@/admin/kit/table/list-return';
import { useNextUrlState } from '@/admin/kit/table/url-state';
import { Can } from '@/admin/session/can';
import { useCan } from '@/admin/session/session-provider';

import {
  CATEGORY_TREE_CACHE_KEY,
  PRODUCT_KIND,
  PRODUCT_STATUS,
  loadCategoryTreeOptions,
  options,
} from '../catalog-enums';

const TABS: { key: AdminProductTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'on_shelf', label: '出售中' },
  { key: 'off_shelf', label: '已下架' },
  { key: 'draft', label: '草稿' },
  { key: 'sold_out', label: '已售罄' },
  { key: 'stock_warning', label: '库存预警' },
  { key: 'deleted', label: '回收站' },
];

function isTab(value: string | undefined): value is AdminProductTab {
  return TABS.some((tab) => tab.key === value);
}

/**
 * 商品列表.
 *
 * Seven tabs, as one `tab` query key rather than a
 * `type` integer whose meaning changed between screens. Three of them
 * (`sold_out`, `stock_warning`, `deleted`) are *derived* server-side rather
 * than stored, so a product cannot be "sold out" in the list and in stock on
 * the detail page.
 *
 * The tab lives in the URL next to the filters, so a colleague opening the link
 * lands on the same screen. Everything else is the kit: `CrudTable` owns
 * paging, sorting and the filter bar.
 */
export function ProductListPage() {
  const urlState = useNextUrlState();
  // 编辑 and 卡密 come back to this tab, these filters and this page.
  const detailHref = useDetailHref();
  // The 分类 filter loads the category tree: only for a role that may read it.
  const mayReadCategories = useCan()('catalog:category:read');
  const categoryFilter: FilterSpec[] = mayReadCategories
    ? [
        {
          kind: 'custom',
          name: 'categoryId',
          label: '商品分类',
          render: (value, onChange) => (
            <TreeSelectField
              value={value}
              onChange={(next) => onChange(typeof next === 'string' ? next : undefined)}
              loadOptions={loadCategoryTreeOptions}
              cacheKey={CATEGORY_TREE_CACHE_KEY}
              placeholder="全部分类"
            />
          ),
        },
      ]
    : [];
  const initial = urlState.read('tab');
  const [tab, setTab] = useState<AdminProductTab>(isTab(initial) ? initial : 'all');

  const changeTab = (next: AdminProductTab): void => {
    setTab(next);
    // Page 1: what was row 40 of 出售中 is not row 40 of 回收站.
    urlState.write({ tab: next, page: '1' });
  };

  const setStatus = useRouteMutation(catalogAdminProductSetStatus, {
    invalidate: [catalogAdminProductList, catalogAdminProductDetail],
    successMessage: '已更新上架状态',
  });

  const restore = useRouteMutation(catalogAdminProductRestore, {
    invalidate: [catalogAdminProductList, catalogAdminProductDetail],
    successMessage: '已恢复，商品处于下架状态',
  });

  const deleted = tab === 'deleted';

  return (
    <PageContainer
      subTitle="回收站里的商品不参与前台展示，但订单里的历史记录仍然指向它"
      tabs={
        <Tabs
          activeKey={tab}
          onChange={(key) => changeTab(key as AdminProductTab)}
          items={TABS.map((item) => ({ key: item.key, label: item.label }))}
        />
      }
    >
      <CrudTable
        route={catalogAdminProductList}
        scrollX={1600}
        fixedQuery={{ tab }}
        filters={[
          { kind: 'text', name: 'keyword', label: '商品名称' },
          ...categoryFilter,
          { kind: 'select', name: 'kind', label: '商品类型', options: options(PRODUCT_KIND) },
          { kind: 'text', name: 'labelId', label: '标签 ID' },
          { kind: 'money', name: 'priceFrom', label: '价格从' },
          { kind: 'money', name: 'priceTo', label: '价格到' },
        ]}
        toolbar={
          <>
            <Can permission="catalog:product:write">
              <Link href={detailHref('/admin/catalog/products/new')}>
                <Button type="primary">新建商品</Button>
              </Link>
            </Can>
            <ExportButton tab={tab} urlRead={urlState.read} />
          </>
        }
        columns={[
          idColumn<AdminProductListItem>({ sortable: true }),
          imageColumn<AdminProductListItem>({ title: '图片', dataIndex: 'imageUrl' }),
          {
            title: '商品名称',
            key: 'name',
            render: (_value: unknown, row: AdminProductListItem) => (
              <Space direction="vertical" size={0} style={{ maxWidth: 320 }}>
                <Link href={detailHref(`/admin/catalog/products/${row.id}`)}>
                  <Typography.Text ellipsis={{ tooltip: row.name }}>{row.name}</Typography.Text>
                </Link>
                {row.subtitle ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.subtitle}
                  </Typography.Text>
                ) : null}
                <Space size={4} wrap>
                  {row.categoryNames.map((name) => (
                    <Typography.Text key={name} type="secondary" style={{ fontSize: 12 }}>
                      #{name}
                    </Typography.Text>
                  ))}
                </Space>
              </Space>
            ),
          },
          {
            title: '类型',
            key: 'kind',
            width: 110,
            render: (_value: unknown, row: AdminProductListItem) => (
              <StatusTag value={row.kind} map={PRODUCT_KIND} />
            ),
          },
          moneyColumn<AdminProductListItem>({ title: '售价', dataIndex: 'price', sortable: true }),
          {
            title: '库存',
            key: 'stock',
            width: 100,
            sorter: true,
            align: 'right' as const,
            render: (_value: unknown, row: AdminProductListItem) =>
              row.stock === 0 ? (
                <Typography.Text type="danger">0</Typography.Text>
              ) : (
                <span>{row.stock}</span>
              ),
          },
          {
            title: '销量',
            key: 'sales',
            width: 120,
            sorter: true,
            align: 'right' as const,
            render: (_value: unknown, row: AdminProductListItem) => (
              // Real sales and the number the storefront shows are two
              // different things, so they are never one number.
              <Tooltip title={`真实销量 ${row.sales}，前台虚拟加量 ${row.displaySalesBoost}`}>
                <span>
                  {row.sales}
                  {row.displaySalesBoost > 0 ? (
                    <Typography.Text type="secondary"> +{row.displaySalesBoost}</Typography.Text>
                  ) : null}
                </span>
              </Tooltip>
            ),
          },
          {
            title: '浏览',
            key: 'views',
            width: 80,
            align: 'right' as const,
            render: (_value: unknown, row: AdminProductListItem) => row.views,
          },
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: AdminProductListItem) => (
              <StatusTag value={row.status} map={PRODUCT_STATUS} />
            ),
          },
          {
            title: '排序',
            key: 'sortOrder',
            width: 80,
            sorter: true,
            align: 'right' as const,
            render: (_value: unknown, row: AdminProductListItem) => row.sortOrder,
          },
          instantColumn<AdminProductListItem>({
            title: deleted ? '删除时间' : '创建时间',
            dataIndex: deleted ? 'deletedAt' : 'createdAt',
            sortable: !deleted,
          }),
          {
            title: '操作',
            key: '__actions__',
            width: 230,
            fixed: 'right' as const,
            render: (_value: unknown, row: AdminProductListItem) =>
              deleted ? (
                <Space size={4} wrap>
                  <Can permission="catalog:product:delete">
                    <Button
                      type="link"
                      size="small"
                      loading={restore.isPending && restore.variables?.params?.id === row.id}
                      onClick={() => restore.mutate({ params: { id: row.id }, body: {} })}
                    >
                      恢复
                    </Button>
                  </Can>
                </Space>
              ) : (
                <Space size={4} wrap>
                  <Can permission="catalog:product:write">
                    <Link href={detailHref(`/admin/catalog/products/${row.id}`)}>
                      <Button type="link" size="small">
                        编辑
                      </Button>
                    </Link>
                    <ConfirmAction
                      type="link"
                      size="small"
                      loading={setStatus.isPending && setStatus.variables?.params?.id === row.id}
                      confirm={
                        row.status === 'on_shelf'
                          ? {
                              title: `下架「${row.name}」？`,
                              description: '前台立即看不到该商品，已加入购物车的也无法结算。',
                              okText: '下架',
                            }
                          : undefined
                      }
                      onAction={() =>
                        setStatus.mutate({
                          params: { id: row.id },
                          body: { status: row.status === 'on_shelf' ? 'off_shelf' : 'on_shelf' },
                        })
                      }
                    >
                      {row.status === 'on_shelf' ? '下架' : '上架'}
                    </ConfirmAction>
                  </Can>
                  {row.kind === 'virtual_card' ? (
                    <Can permission="catalog:card:read">
                      <Link href={detailHref(`/admin/catalog/products/${row.id}/cards`)}>
                        <Button type="link" size="small">
                          卡密
                        </Button>
                      </Link>
                    </Can>
                  ) : null}
                  <ConfirmButton
                    route={catalogAdminProductDelete}
                    input={{ params: { id: row.id } }}
                    title={`将「${row.name}」移入回收站？`}
                    description="前台立即下架；有未完成订单时会被拒绝。"
                    invalidate={[catalogAdminProductList]}
                    successMessage="已移入回收站"
                    permission="catalog:product:delete"
                    buttonProps={{ type: 'link', size: 'small', danger: true }}
                  >
                    删除
                  </ConfirmButton>
                </Space>
              ),
          },
        ]}
      />
    </PageContainer>
  );
}

/**
 * 导出商品.
 *
 * The rows arrive as JSON through the same validated `handle()` pipeline as
 * every other route and become a CSV here, rather than the server streaming a
 * file down a second, unvalidated path. The file carries a BOM because Excel
 * on Windows reads a BOM-less UTF-8 CSV as GBK and turns every Chinese product
 * name into mojibake.
 *
 * The permission is its own atom: the export includes **cost prices**, and
 * being allowed to edit a product is not being allowed to download the shop's
 * margins.
 */
function ExportButton({
  tab,
  urlRead,
}: {
  tab: AdminProductTab;
  urlRead: (key: string) => string | undefined;
}) {
  const exportRows = useRouteMutation(catalogAdminProductExport, { presentError: true });

  const run = (): void => {
    const keyword = urlRead('keyword');
    const categoryId = urlRead('categoryId');
    const kind = urlRead('kind');
    exportRows.mutate(
      {
        query: {
          tab,
          ...(keyword ? { keyword } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(kind ? { kind: kind as never } : {}),
          limit: 2000,
        },
      },
      {
        onSuccess: (result) => {
          downloadCsv(result);
          void message.success(
            result.truncated
              ? `已导出前 ${result.rows.length} 条，共 ${result.total} 条，请缩小筛选范围`
              : `已导出 ${result.rows.length} 条`,
          );
        },
      },
    );
  };

  return (
    <Can permission="catalog:product:export">
      <Button loading={exportRows.isPending} onClick={run}>
        导出
      </Button>
    </Can>
  );
}

/**
 * Always quoted. A leading `=`, `+`, `-` or `@` gets a `'` first so a
 * spreadsheet shows a product called `=HYPERLINK(…)` as text instead of
 * running it.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function downloadCsv(result: ProductExportResult): void {
  const header = result.columns.map((column) => csvCell(column.title)).join(',');
  const body = result.rows
    .map((row) => result.columns.map((column) => csvCell(row[column.key] ?? '')).join(','))
    .join('\r\n');
  const blob = new Blob(['﻿', `${header}\r\n${body}`], {
    type: 'text/csv;charset=utf-8',
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
