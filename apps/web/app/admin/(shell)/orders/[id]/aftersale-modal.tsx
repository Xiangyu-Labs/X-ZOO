'use client';

import { Alert, InputNumber, Space, Table, Typography } from 'antd';
import { useMemo } from 'react';
import {
  orderAdminDetail,
  orderAdminList,
  orderAdminTimeline,
} from '@shop/contracts/order/order.admin.contract';
import {
  refundAdminApplicable,
  refundAdminCreate,
  refundAdminDetail,
  refundAdminList,
} from '@shop/contracts/refund/refund.admin.contract';
import {
  refundKind,
  type AdminRefundDetail,
  type RefundableItem,
  type RefundableItemsResult,
} from '@shop/contracts/refund/schemas';
import { z } from 'zod';

import { errorMessage, useRouteQuery } from '@/admin/api';
import { ModalForm } from '@/admin/kit/form/modal-form';
import { fenToMoney, isMoney, moneyToFen } from '@/admin/kit/money';
import { MoneyText } from '@/admin/kit/money-text';
import { useOutcomeToast, type Outcome } from '@/admin/kit/outcome-toast';
import { Thumbnail } from '@/admin/kit/thumbnail';

/** Units per order line, keyed by `orderItemId`; a line left at 0 is not in the request. */
type Quantities = Record<string, number>;

const aftersaleFields = z.object({
  kind: refundKind,
  quantities: z
    .record(z.string(), z.number().int().min(0))
    .refine((q) => Object.values(q).some((n) => n > 0), '请选择要售后的商品和数量'),
  /** 仅退款 only: what goes back, at most what the chosen lines are worth. */
  amount: z.string().optional(),
  reason: z.string().trim().min(1, '请填写售后原因').max(255),
  remark: z.string().max(255).optional(),
  includeFreight: z.boolean().optional(),
});
type AftersaleForm = z.output<typeof aftersaleFields>;

/**
 * The form with its cross-field check: a 仅退款 names an amount, and not more
 * than the chosen lines (and freight) are estimated at. The server prices it
 * again and has the last word (`REFUND_AMOUNT_ABOVE_ITEMS`).
 */
export function aftersaleForm(applicable: RefundableItemsResult | undefined) {
  return aftersaleFields.superRefine((values, ctx) => {
    if (values.kind !== 'refund_only') return;
    if (values.amount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: '请填写退款金额' });
      return;
    }
    if (!isMoney(values.amount)) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: '请填写正确的金额，例如 12.50' });
      return;
    }
    const fen = moneyToFen(values.amount);
    if (fen <= 0n) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: '退款金额必须大于 0' });
      return;
    }
    if (applicable === undefined) return;
    const ceiling = ceilingFen(applicable, values);
    if (fen > ceiling) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: `不能超过所选商品的可退金额 ¥${fenToMoney(ceiling)}`,
      });
    }
  });
}

/** The estimate for the chosen lines, plus freight when it is asked for. */
function ceilingFen(applicable: RefundableItemsResult, values: AftersaleForm): bigint {
  const lines = estimateFen(applicable.items, values.quantities);
  return values.includeFreight && applicable.freightRefundable
    ? lines + moneyToFen(applicable.freightAmount)
    : lines;
}

/** Every screen that shows what a new after-sales changes. */
const REFRESHES = [
  orderAdminDetail,
  orderAdminTimeline,
  orderAdminList,
  refundAdminApplicable,
  refundAdminList,
  refundAdminDetail,
] as const;

const KIND_OPTIONS = [
  { label: '退货退款', value: 'return_and_refund' },
  { label: '仅退款', value: 'refund_only' },
] as const;

/**
 * 发起售后 — the shop opens after-sales on an order itself, typically one the
 * buyer can no longer apply on (completed, the window gone).
 *
 * The operator picks the kind, the lines and the units; the server prices them
 * exactly as it prices a buyer's request, so the total here is only an
 * estimate and the toast reports the amount the server froze. A 仅退款 also
 * names its amount — up to that estimate, for a refund the buyer and the shop
 * agreed on — while a 退货退款 gives back what the goods are worth. It opens
 * already approved: a 仅退款 goes to WeChat on submit, a 退货退款 waits for the
 * goods.
 */
export function AftersaleModal({
  orderId,
  open,
  onClose,
}: {
  orderId: string;
  open: boolean;
  onClose: () => void;
}) {
  // Read every time the dialog opens: another request may have taken a line
  // since the last look.
  const applicable = useRouteQuery(
    refundAdminApplicable,
    { params: { id: orderId } },
    { enabled: open, staleTime: 0, refetchOnMount: 'always', presentError: false },
  );
  const tellOutcome = useOutcomeToast();
  const data = applicable.data;
  const schema = useMemo(() => aftersaleForm(data), [data]);

  return (
    <ModalForm
      open={open}
      onClose={onClose}
      title="发起售后"
      size="large"
      schema={schema}
      initialValues={{ kind: 'return_and_refund', quantities: {}, includeFreight: false }}
      fields={[
        {
          kind: 'radio',
          name: 'kind',
          label: '售后类型',
          options: KIND_OPTIONS,
          optionType: 'button',
        },
        {
          kind: 'custom',
          name: 'quantities',
          label: '商品',
          required: true,
          render: ({ value, onChange, disabled }) => (
            <LinePicker
              items={data?.items ?? []}
              loading={applicable.isPending}
              value={(value as Quantities | undefined) ?? {}}
              onChange={onChange}
              disabled={disabled}
            />
          ),
        },
        ...(data?.freightRefundable
          ? ([
              {
                kind: 'switch',
                name: 'includeFreight',
                label: '退运费',
                help: (
                  <>
                    订单未发货、且退掉全部剩余商品时才能退运费{' '}
                    <MoneyText value={data.freightAmount} />。
                  </>
                ),
              },
            ] as const)
          : []),
        {
          kind: 'money',
          name: 'amount',
          label: '退款金额',
          required: true,
          visibleWhen: (values) => values['kind'] === 'refund_only',
          help: '不能超过上面的预计退款（勾选退运费时含运费）。少退的部分以后不能再退。',
        },
        {
          kind: 'textarea',
          name: 'reason',
          label: '售后原因',
          rows: 2,
          maxLength: 255,
          required: true,
          help: '买家会在售后详情里看到这句话。',
        },
        {
          kind: 'textarea',
          name: 'remark',
          label: '内部备注',
          rows: 2,
          maxLength: 255,
          help: '只在后台可见。',
        },
      ]}
      route={refundAdminCreate}
      toInput={(values: AftersaleForm) => ({
        params: { id: orderId },
        body: aftersaleBody(values),
      })}
      invalidate={REFRESHES}
      onSuccess={(detail) => tellOutcome(aftersaleOutcome(detail))}
      okText="确认发起"
      header={
        <AftersaleHeader applicable={data} error={applicable.isError ? applicable.error : null} />
      }
    />
  );
}

function AftersaleHeader({
  applicable,
  error,
}: {
  applicable: RefundableItemsResult | undefined;
  error: unknown;
}) {
  if (error !== null) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        message={errorMessage(error, '可售后的商品加载失败，请关闭后重试')}
      />
    );
  }
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={
        <>
          不受售后期限限制，提交后直接视为已同意。仅退款会立即原路退回；退货退款按「售后设置」里的退货地址等买家寄回，确认收货后才退款。
          {applicable ? (
            <>
              {' '}
              本单实付 <MoneyText value={applicable.paidAmount} />
              ，已退 <MoneyText value={applicable.refundedAmount} />
              ，最多还能退 <MoneyText value={applicable.refundableAmount} />。
            </>
          ) : null}
        </>
      }
    />
  );
}

/** The lines with how many units of each go into the request. */
function LinePicker({
  items,
  loading,
  value,
  onChange,
  disabled,
}: {
  items: readonly RefundableItem[];
  loading: boolean;
  value: Quantities;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const estimate = estimateFen(items, value);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Table<RefundableItem>
        size="small"
        rowKey={(item) => item.orderItemId}
        pagination={false}
        loading={loading}
        dataSource={[...items]}
        columns={[
          {
            title: '商品',
            key: 'product',
            ellipsis: true,
            render: (_v: unknown, item: RefundableItem) => (
              <Space size={8}>
                {item.productImageUrl ? <Thumbnail src={item.productImageUrl} size={36} /> : null}
                <Space direction="vertical" size={0}>
                  <Typography.Text ellipsis>{item.productName}</Typography.Text>
                  <Typography.Text type="secondary">{item.specText}</Typography.Text>
                </Space>
              </Space>
            ),
          },
          {
            title: '可退',
            key: 'refundable',
            width: 120,
            align: 'right',
            render: (_v: unknown, item: RefundableItem) =>
              item.blockedReason === null ? (
                <>
                  {item.refundableQuantity} 件 / <MoneyText value={item.refundableAmount} />
                </>
              ) : (
                <Typography.Text type="secondary">
                  {blockedText(item.blockedReason)}
                </Typography.Text>
              ),
          },
          {
            title: '售后数量',
            key: 'quantity',
            width: 120,
            render: (_v: unknown, item: RefundableItem) => (
              <InputNumber
                aria-label={`${item.productName} 售后数量`}
                min={0}
                max={item.refundableQuantity}
                precision={0}
                value={value[item.orderItemId] ?? 0}
                disabled={disabled || item.refundableQuantity === 0}
                onChange={(n) => onChange({ ...value, [item.orderItemId]: n ?? 0 })}
              />
            ),
          },
        ]}
      />
      <Typography.Text>
        预计退款 <MoneyText value={fenToMoney(estimate)} />
        <Typography.Text type="secondary">（以提交后的实际金额为准，不含运费）</Typography.Text>
      </Typography.Text>
    </Space>
  );
}

function blockedText(code: string): string {
  return code === 'REFUND_ALREADY_OPEN' ? '已有售后处理中' : '已全部退完';
}

/**
 * What the chosen units would give back, in fen: a line's whole remaining
 * amount when every remaining unit goes, else its share rounded down — the same
 * estimate the mini-program's apply screen shows.
 */
export function estimateFen(items: readonly RefundableItem[], quantities: Quantities): bigint {
  let total = 0n;
  for (const item of items) {
    const units = quantities[item.orderItemId] ?? 0;
    if (units <= 0 || item.refundableQuantity <= 0) continue;
    const all = moneyToFen(item.refundableAmount);
    total +=
      units >= item.refundableQuantity
        ? all
        : (all * BigInt(units)) / BigInt(item.refundableQuantity);
  }
  return total;
}

export function aftersaleBody(values: AftersaleForm) {
  const remark = values.remark?.trim();
  return {
    kind: values.kind,
    lines: Object.entries(values.quantities)
      .filter(([, quantity]) => quantity > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
    // A 退货退款 is worth its goods; an amount left over from switching kinds stays here.
    ...(values.kind === 'refund_only' && values.amount !== undefined
      ? { amount: values.amount }
      : {}),
    reason: values.reason,
    ...(remark ? { remark } : {}),
    includeFreight: values.includeFreight ?? false,
  };
}

/** The toast says what the server actually did, with the amount it froze. */
export function aftersaleOutcome(detail: AdminRefundDetail): Outcome {
  return detail.kind === 'return_and_refund'
    ? { level: 'success', text: `已发起退货退款 ¥${detail.amount}，等待买家寄回` }
    : { level: 'success', text: `已发起退款 ¥${detail.amount}，正在原路退回` };
}
