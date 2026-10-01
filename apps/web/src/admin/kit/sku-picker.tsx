'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Empty, Input, Modal, Space, Spin, Table, Typography } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import {
  catalogAdminProductDetail,
  catalogAdminProductList,
} from '@shop/contracts/catalog/catalog.product.admin.contract';

import { callRoute } from '@/admin/api/call-route';
import { errorMessage } from '@/admin/api/errors';

const PAGE_SIZE = 10;

/**
 * One chosen SKU: what every activity form needs to name a price and a stock
 * ledger, and nothing else.
 *
 * `specText` and `price` are carried along so the caller can *show* the row it
 * just picked without a second read. They are a snapshot for display, never a
 * value to submit — the server re-reads the SKU and refuses one that does not
 * belong to the activity's product (`GROUPBUY_SKU_NOT_IN_ACTIVITY`,
 * `PRESALE_SKU_NOT_IN_ACTIVITY`).
 */
export interface PickedSku {
  productId: string;
  skuId: string;
  specText: string;
  price: string;
  stock: number;
}

export interface SkuPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen SKUs when the operator confirms. */
  onSelect: (skus: PickedSku[]) => void;
  /** Single selection when `false`. Default `true`. */
  multiple?: boolean | undefined;
  /** Cap on the selection. */
  max?: number | undefined;
  /** Skus already chosen, so the picker can pre-tick and de-duplicate. */
  value?: readonly PickedSku[] | undefined;
  /**
   * Restrict the search to one product. The activity forms pass their own
   * `productId`, because a group buy on product 12 cannot price a SKU of
   * product 13 and offering one would only earn a 422.
   */
  productId?: string | undefined;
  title?: string | undefined;
}

interface ProductRow {
  id: string;
  name: string;
  imageUrl: string;
  price: string;
  stock: number;
  specMode: boolean;
}

/**
 * 选择商品规格 — search products, expand one, tick its SKUs.
 *
 * Built out of kit primitives and the generated contracts client only: it
 * reads the catalog's own `/admin-api/catalog/products` (keyword search) and
 * `/admin-api/catalog/products/:id` (the SKU rows), so it shows exactly what
 * the product page shows and cannot drift into a second definition of "a
 * sellable SKU". No domain import, no second copy of the catalog's rules.
 *
 * Why a picker at all: the alternative is a typed-in SKU id on every activity
 * form (规格 lists, 推荐商品). A mistyped id is a 422 at
 * best and a *valid id of the wrong product* at worst — priced wrong, in
 * stock, and nobody notices until the sale.
 */
export function SkuPicker({
  open,
  onClose,
  onSelect,
  multiple = true,
  max,
  value,
  productId,
  title = '选择商品规格',
}: SkuPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | undefined>(productId);
  const [picked, setPicked] = useState<PickedSku[]>([...(value ?? [])]);

  /**
   * Re-opening starts from the caller's current value rather than from
   * whatever the last visit left behind.
   *
   * Adjusted during render rather than in an effect — React's own "resetting
   * state when a prop changes" pattern. An effect would paint the stale
   * selection for one frame and `react-hooks/set-state-in-effect` refuses it.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPicked([...(value ?? [])]);
      setKeyword('');
      setSearch('');
      setPage(1);
      setExpanded(productId);
    }
  }

  const products = useQuery({
    queryKey: ['kit.skuPicker.products', search, page, productId ?? null],
    queryFn: () =>
      callRoute(catalogAdminProductList, {
        query: {
          page,
          pageSize: PAGE_SIZE,
          tab: 'on_shelf' as const,
          ...(search === '' ? {} : { keyword: search }),
        },
      }),
    enabled: open && productId === undefined,
  });

  const detail = useQuery({
    queryKey: ['kit.skuPicker.detail', expanded ?? null],
    queryFn: () => callRoute(catalogAdminProductDetail, { params: { id: expanded ?? '' } }),
    enabled: open && expanded !== undefined,
  });

  const rows: ProductRow[] = useMemo(() => {
    if (productId !== undefined) {
      const loaded = detail.data;
      return loaded === undefined
        ? []
        : [
            {
              id: loaded.id,
              name: loaded.name,
              imageUrl: loaded.imageUrl,
              price: loaded.price,
              stock: loaded.stock,
              specMode: loaded.specMode,
            },
          ];
    }
    return (products.data?.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      price: item.price,
      stock: item.stock,
      specMode: item.specMode,
    }));
  }, [products.data, detail.data, productId]);

  const isPicked = useCallback(
    (skuId: string) => picked.some((row) => row.skuId === skuId),
    [picked],
  );

  const toggle = useCallback(
    (sku: PickedSku) => {
      setPicked((current) => {
        if (current.some((row) => row.skuId === sku.skuId)) {
          return current.filter((row) => row.skuId !== sku.skuId);
        }
        if (!multiple) return [sku];
        if (max !== undefined && current.length >= max) return current;
        return [...current, sku];
      });
    },
    [multiple, max],
  );

  const confirm = () => {
    onSelect(picked);
    onClose();
  };

  const skuRows =
    detail.data === undefined
      ? []
      : detail.data.skus.map((sku) => ({
          productId: detail.data!.id,
          skuId: sku.id,
          specText: sku.specText,
          price: sku.price,
          stock: sku.stock,
        }));

  return (
    <Modal
      open={open}
      title={title}
      width={720}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <Space>
          <Typography.Text type="secondary">已选 {picked.length} 条</Typography.Text>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={picked.length === 0} onClick={confirm}>
            确定
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {productId === undefined ? (
          <Input.Search
            allowClear
            placeholder="搜索商品名称"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={(next) => {
              setSearch(next);
              setPage(1);
              setExpanded(undefined);
            }}
            enterButton="搜索"
          />
        ) : (
          <Alert type="info" showIcon message="只能选择当前商品的规格" />
        )}

        {products.isError ? (
          <Alert
            type="error"
            showIcon
            message={errorMessage(products.error, '商品加载失败，请重试')}
          />
        ) : null}

        <Table<ProductRow>
          rowKey="id"
          size="small"
          dataSource={rows}
          loading={products.isFetching}
          locale={{ emptyText: <Empty description="没有匹配的商品" /> }}
          pagination={
            productId === undefined
              ? {
                  current: page,
                  pageSize: PAGE_SIZE,
                  total: products.data?.total ?? 0,
                  onChange: (next) => setPage(next),
                  showSizeChanger: false,
                }
              : false
          }
          expandable={{
            expandedRowKeys: expanded === undefined ? [] : [expanded],
            onExpand: (open_, record) => setExpanded(open_ ? record.id : undefined),
            expandedRowRender: () =>
              detail.isPending ? (
                <Spin size="small" />
              ) : skuRows.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该商品没有规格" />
              ) : (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {skuRows.map((sku) => (
                    <Checkbox
                      key={sku.skuId}
                      checked={isPicked(sku.skuId)}
                      onChange={() => toggle(sku)}
                    >
                      {sku.specText}
                      <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                        ￥{sku.price} · 库存 {sku.stock}
                      </Typography.Text>
                    </Checkbox>
                  ))}
                </Space>
              ),
          }}
          columns={[
            {
              title: '商品',
              dataIndex: 'name',
              render: (_: unknown, record: ProductRow) => (
                <Space>
                  {record.imageUrl === '' ? null : (
                    <img src={record.imageUrl} alt="" width={32} height={32} />
                  )}
                  <span>{record.name}</span>
                </Space>
              ),
            },
            { title: '价格', dataIndex: 'price', width: 100 },
            { title: '库存', dataIndex: 'stock', width: 80 },
          ]}
        />
      </Space>
    </Modal>
  );
}
