'use client';

import { Alert, Button, Input, Typography, message } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { z } from 'zod';
import {
  catalogAdminProductDetail,
  catalogAdminVirtualCardImport,
  catalogAdminVirtualCardList,
  catalogAdminVirtualCardVoid,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import type { ProductVirtualCard } from '@shop/contracts/catalog/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ModalForm } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { useListReturn } from '@/admin/kit/table/list-return';
import { ConfirmAction } from '@/admin/kit/confirm-action';
import { Can } from '@/admin/session/can';

import { VIRTUAL_CARD_STATE, options } from '../../../catalog-enums';

/**
 * 卡密库存.
 *
 * The card pool **is** the stock: importing cards raises
 * `product_skus.stock` in the same transaction, voiding an unclaimed card
 * lowers it, and the product editor refuses a hand-typed stock for a card
 * product. Kept apart, the two drift, and the shop sells cards that do not
 * exist.
 *
 * Card numbers are readable here and nowhere else in the admin, under their own
 * `catalog:card:read` atom — the rows are redeemable secrets, and seeing a card
 * number is not the same job as seeing a product.
 */
export function VirtualCardsPage({ productId }: { productId: string }) {
  const [importing, setImporting] = useState(false);

  const product = useRouteQuery(catalogAdminProductDetail, { params: { id: productId } });
  const { listHref, keepList } = useListReturn('/admin/catalog/products');
  const skus = product.data?.skus ?? [];

  const voidCards = useRouteMutation(catalogAdminVirtualCardVoid, {
    invalidate: [catalogAdminVirtualCardList, catalogAdminProductDetail],
  });

  return (
    <PageContainer
      title={product.data ? `卡密库存：${product.data.name}` : '卡密库存'}
      subTitle="导入的卡密数量就是该规格的库存；已发放的卡密不能作废"
      breadcrumb={[{ label: '商品', href: listHref }, { label: '卡密库存' }]}
      extra={
        <Link href={keepList(`/admin/catalog/products/${productId}`)}>
          <Button>编辑商品</Button>
        </Link>
      }
    >
      {product.data && product.data.kind !== 'virtual_card' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这个商品不是卡密商品，导入的卡密不会发放给买家。"
        />
      ) : null}

      <CrudTable
        route={catalogAdminVirtualCardList}
        params={{ id: productId }}
        scrollX={1100}
        toolbar={
          <Can permission="catalog:card:write">
            <Button type="primary" onClick={() => setImporting(true)}>
              导入卡密
            </Button>
          </Can>
        }
        filters={[
          {
            kind: 'select',
            name: 'skuId',
            label: '规格',
            options: skus.map((sku) => ({
              label: sku.specText || '单规格',
              value: sku.id,
            })),
          },
          {
            kind: 'select',
            name: 'state',
            label: '状态',
            options: options(VIRTUAL_CARD_STATE),
          },
        ]}
        batchActions={({ selectedRows, clear }) => {
          const voidable = selectedRows.filter((row) => row.state === 'unclaimed');
          return (
            <Can permission="catalog:card:write">
              <ConfirmAction
                size="small"
                danger
                loading={voidCards.isPending}
                // Nothing to void is said at once; voiding asks first — it cannot be undone.
                confirm={
                  voidable.length > 0
                    ? {
                        title: `作废选中的 ${voidable.length} 条未发放卡密？`,
                        description: '作废后不能恢复，库存相应减少。',
                        okText: '作废',
                      }
                    : undefined
                }
                onAction={() => {
                  if (voidable.length === 0) {
                    void message.warning('只有未发放的卡密可以作废');
                    return;
                  }
                  voidCards.mutate(
                    {
                      params: { id: productId },
                      body: { cardIds: voidable.map((row) => row.id) },
                    },
                    {
                      onSuccess: (result) => {
                        void message.success(
                          `已作废 ${result.voided} 条，剩余库存 ${result.stock}`,
                        );
                        clear();
                      },
                    },
                  );
                }}
              >
                批量作废
              </ConfirmAction>
            </Can>
          );
        }}
        columns={[
          idColumn<ProductVirtualCard>(),
          textColumn<ProductVirtualCard>({
            title: '规格',
            dataIndex: 'specText',
            placeholder: '单规格',
            width: 140,
          }),
          textColumn<ProductVirtualCard>({ title: '卡号', dataIndex: 'cardNo', width: 200 }),
          textColumn<ProductVirtualCard>({
            title: '卡密',
            dataIndex: 'cardSecret',
            width: 200,
            ellipsis: true,
          }),
          {
            title: '状态',
            key: 'state',
            width: 100,
            render: (_value: unknown, row: ProductVirtualCard) => (
              <StatusTag value={row.state} map={VIRTUAL_CARD_STATE} />
            ),
          },
          textColumn<ProductVirtualCard>({
            title: '订单明细 ID',
            dataIndex: 'orderItemId',
            width: 120,
          }),
          textColumn<ProductVirtualCard>({
            title: '领取用户',
            dataIndex: 'claimedByUserId',
            width: 110,
          }),
          instantColumn<ProductVirtualCard>({ title: '发放时间', dataIndex: 'claimedAt' }),
          instantColumn<ProductVirtualCard>({ title: '导入时间', dataIndex: 'createdAt' }),
        ]}
      />

      <ImportModal
        productId={productId}
        skus={skus.map((sku) => ({ id: sku.id, specText: sku.specText }))}
        open={importing}
        onClose={() => setImporting(false)}
      />
    </PageContainer>
  );
}

/**
 * 导入卡密.
 *
 * One card per line, `卡号,卡密` — the shape the supplier's spreadsheet exports
 * and the operator pastes. Duplicates inside the SKU's pool are reported back
 * rather than rejected wholesale: re-pasting a batch that half-landed is the
 * normal way this goes wrong, and it must be safe.
 */
const MAX_CARDS = 1000;

const importForm = z.object({
  skuId: z.string({ error: '请选择规格' }).min(1, '请选择规格'),
  cards: z
    .string()
    .trim()
    .min(1, '请粘贴至少一条卡密')
    .superRefine((raw, ctx) => {
      const cards = parseCards(raw);
      if (cards.length > MAX_CARDS) {
        ctx.addIssue({
          code: 'custom',
          message: `单次最多导入 ${MAX_CARDS} 条，现在有 ${cards.length} 条，请分批导入`,
        });
        return;
      }
      const long = cards.findIndex(
        (card) => card.cardNo.length > 255 || (card.cardSecret ?? '').length > 255,
      );
      if (long >= 0) {
        ctx.addIssue({ code: 'custom', message: `第 ${long + 1} 条的卡号或卡密超过 255 个字` });
      }
    }),
});

/** The textarea, and how many cards it holds as the operator pastes. */
function CardsInput({
  value,
  onChange,
  disabled,
  id,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  id?: string | undefined;
}) {
  const text = typeof value === 'string' ? value : '';
  const count = parseCards(text).length;
  return (
    <>
      <Input.TextArea
        id={id}
        rows={10}
        value={text}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={'8800-1234-5678,9f2a\n8800-1234-5679,7b1c'}
      />
      <Typography.Text type={count > MAX_CARDS ? 'danger' : 'secondary'}>
        已识别 {count} 条（上限 {MAX_CARDS}）
      </Typography.Text>
    </>
  );
}

function ImportModal({
  productId,
  skus,
  open,
  onClose,
}: {
  productId: string;
  skus: readonly { id: string; specText: string }[];
  open: boolean;
  onClose: () => void;
}) {
  const first = skus[0]?.id;

  return (
    <ModalForm
      open={open}
      onClose={onClose}
      title="导入卡密"
      okText="导入"
      schema={importForm}
      header={
        skus.length === 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="该商品还没有规格，请先保存商品"
          />
        ) : null
      }
      fields={[
        {
          kind: 'select',
          name: 'skuId',
          label: '规格',
          options: skus.map((sku) => ({ label: sku.specText || '单规格', value: sku.id })),
          allowClear: false,
        },
        {
          kind: 'custom',
          name: 'cards',
          label: '卡密',
          help: `一行一条，格式「卡号,卡密」；只有卡号时卡密留空。单次最多 ${MAX_CARDS} 条。`,
          render: (props) => <CardsInput {...props} />,
        },
      ]}
      {...(first ? { initialValues: { skuId: first } } : {})}
      route={catalogAdminVirtualCardImport}
      toInput={(values) => ({
        params: { id: productId },
        body: { skuId: values.skuId, cards: parseCards(values.cards) },
      })}
      invalidate={[catalogAdminVirtualCardList, catalogAdminProductDetail]}
      onSuccess={(result) => {
        void message.success(
          result.skippedCardNos.length === 0
            ? `已导入 ${result.imported} 条，库存 ${result.stock}`
            : `已导入 ${result.imported} 条，${result.skippedCardNos.length} 条卡号重复已跳过`,
        );
      }}
    />
  );
}

/** `卡号,卡密` per line. Commas, tabs and full-width commas all separate. */
export function parseCards(raw: string): { cardNo: string; cardSecret?: string }[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [cardNo, ...rest] = line.split(/[,\t，]/).map((part) => part.trim());
      const cardSecret = rest.join('').trim();
      return { cardNo: cardNo ?? '', ...(cardSecret ? { cardSecret } : {}) };
    })
    .filter((card) => card.cardNo.length > 0);
}
