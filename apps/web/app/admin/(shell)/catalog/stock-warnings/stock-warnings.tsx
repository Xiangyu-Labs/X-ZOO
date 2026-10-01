'use client';

import { Button, Typography } from 'antd';
import Link from 'next/link';
import { catalogAdminStockWarnings } from '@shop/contracts/catalog/catalog.product.admin.contract';
import type { StockWarningItem } from '@shop/contracts/catalog/schemas';

import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { idColumn, imageColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { PRODUCT_STATUS } from '../catalog-enums';

/**
 * 库存预警 — one row per SKU, not per product.
 *
 * A product whose total stock looks healthy can still be out of the one size
 * everybody buys, which is exactly the case a product-level warning misses. The
 * threshold comes from `catalog.stockWarningThreshold`; the filter below
 * overrides it for one look without changing the setting.
 */
export function StockWarningsPage() {
  return (
    <PageContainer subTitle="按规格统计；低于阈值的规格都会列出，卡密商品的库存是卡密池的余量">
      <CrudTable
        route={catalogAdminStockWarnings}
        rowKey="skuId"
        scrollX={1000}
        filters={[
          { kind: 'text', name: 'keyword', label: '商品名称' },
          { kind: 'text', name: 'categoryId', label: '分类 ID' },
          { kind: 'number', name: 'threshold', label: '库存低于', min: 0 },
        ]}
        emptyText="没有低于预警值的规格"
        columns={[
          idColumn<StockWarningItem>({ title: '商品 ID', dataIndex: 'productId' }),
          imageColumn<StockWarningItem>({ title: '图片', dataIndex: 'imageUrl' }),
          {
            title: '商品名称',
            key: 'productName',
            render: (_value: unknown, row: StockWarningItem) => (
              <Link href={`/admin/catalog/products/${row.productId}`}>{row.productName}</Link>
            ),
          },
          textColumn<StockWarningItem>({
            title: '规格',
            dataIndex: 'specText',
            placeholder: '单规格',
            ellipsis: true,
          }),
          textColumn<StockWarningItem>({ title: '规格编码', dataIndex: 'skuCode', width: 180 }),
          {
            title: '商品状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: StockWarningItem) => (
              <StatusTag value={row.status} map={PRODUCT_STATUS} />
            ),
          },
          {
            title: '剩余库存',
            key: 'stock',
            width: 110,
            align: 'right' as const,
            render: (_value: unknown, row: StockWarningItem) => (
              <Typography.Text type={row.stock === 0 ? 'danger' : 'warning'} strong>
                {row.stock}
              </Typography.Text>
            ),
          },
          {
            title: '预警值',
            key: 'threshold',
            width: 90,
            align: 'right' as const,
            render: (_value: unknown, row: StockWarningItem) => (
              <Typography.Text type="secondary">{row.threshold}</Typography.Text>
            ),
          },
          {
            title: '操作',
            key: '__actions__',
            width: 110,
            fixed: 'right' as const,
            render: (_value: unknown, row: StockWarningItem) => (
              <Link href={`/admin/catalog/products/${row.productId}`}>
                <Button type="link" size="small">
                  去补货
                </Button>
              </Link>
            ),
          },
        ]}
      />
    </PageContainer>
  );
}
