'use client';

import { Alert, Button, Collapse, Space, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  paymentAdminExceptionDetail,
  paymentAdminExceptionIgnore,
  paymentAdminExceptionList,
  paymentAdminExceptionRecheck,
  paymentAdminExceptionRefund,
} from '@shop/contracts/payment/payment.admin.contract';
import {
  paymentExceptionIgnoreBody,
  paymentExceptionRefundBody,
  type PaymentExceptionDetail,
  type PaymentExceptionListItem,
} from '@shop/contracts/payment/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { DetailDrawer } from '@/admin/kit/detail-drawer';
import { ErrorSummary } from '@/admin/kit/error-summary';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { InstantText } from '@/admin/kit/instant-text';
import { MoneyText } from '@/admin/kit/money-text';
import { useOutcomeToast, type Outcome } from '@/admin/kit/outcome-toast';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  CodeText,
  codeWidth,
  codeColumn,
  enumColumn,
  errorColumn,
  idColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { useUrlDetailId } from '@/admin/kit/table/url-state';
import { useCan } from '@/admin/session/session-provider';

import { PAYMENT_EXCEPTION_REASON, PAYMENT_EXCEPTION_STATUS, optionsOf } from '../trade-enums';

/**
 * 异常支付 — money the shop is holding and cannot book against an order.
 *
 * This is the page that exists so nobody has to open a database console during
 * an incident. Every row is real money already in the merchant account that the
 * system could not attribute: a duplicate payment, a payment for an order that
 * was cancelled first, an amount that does not match, or a merchant order
 * number we have never issued.
 *
 * The system refunds these automatically — holding a stranger's money is the
 * one outcome with no acceptable explanation — so most rows pass through
 * 待处理 → 退款中 → 已退款 without a human. The three buttons are for the rows
 * that do not:
 *
 *  - **退款** re-drives the automatic refund by the *frozen* `refundNo`. It
 *    never mints a new one, so pressing it twice cannot refund twice
 *    (REFUND-005).
 *  - **查询结果** asks WeChat what happened to a refund whose answer was lost.
 *    It is the only honest way out of 退款未知; waiting does not resolve it.
 *  - **忽略** requires a written reason, because "why did we keep this money"
 *    is the entire point of the row. It changes no money and is reversible only
 *    by refunding afterwards.
 *
 * Note what is *not* here: no field an operator can type an amount into. The
 * refund amount is whatever WeChat says arrived, and an operator correcting it
 * by hand is how a shop refunds more than it was paid.
 */
export function PaymentExceptionsPage() {
  // `?detail=<id>` is what the admin notification links to (NOTIF-008).
  const [detailId, setDetailId] = useUrlDetailId();
  const ignoreModal = useFormModal<PaymentExceptionListItem>();
  const refundModal = useFormModal<PaymentExceptionListItem>();
  const tellOutcome = useOutcomeToast();
  const handlers: ExceptionActionHandlers = {
    refund: (row) => refundModal.show(row),
    ignore: (row) => ignoreModal.show(row),
  };

  return (
    <PageContainer subTitle="已收到但无法计入订单的款项；系统会自动退回，这里处理退不掉的">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="退款按固定的商户退款单号重发，重复点击不会重复退款；金额永远是微信报告的到账金额，无法手工修改。"
      />
      <CrudTable
        route={paymentAdminExceptionList}
        scrollX={1600}
        filters={[
          { kind: 'text', name: 'keyword', label: '单号', placeholder: '商户单号或微信单号' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: optionsOf(PAYMENT_EXCEPTION_STATUS),
          },
          {
            kind: 'select',
            name: 'reason',
            label: '原因',
            options: optionsOf(PAYMENT_EXCEPTION_REASON),
          },
          { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '发生时间' },
        ]}
        columns={[
          idColumn<PaymentExceptionListItem>({ sortable: true }),
          {
            title: '订单',
            key: 'order',
            width: codeWidth(26),
            render: (_value: unknown, row: PaymentExceptionListItem) =>
              row.orderNo === null ? (
                <Typography.Text type="secondary">无法匹配</Typography.Text>
              ) : (
                <CodeText
                  value={row.orderNo}
                  href={row.orderId ? `/admin/orders/${row.orderId}` : undefined}
                />
              ),
          },
          codeColumn<PaymentExceptionListItem>({
            title: '微信单号',
            dataIndex: 'transactionId',
            chars: 28,
          }),
          moneyColumn<PaymentExceptionListItem>({
            title: '到账金额',
            dataIndex: 'paidAmount',
            sortable: true,
          }),
          enumColumn<PaymentExceptionListItem, PaymentExceptionListItem['reason']>({
            title: '原因',
            dataIndex: 'reason',
            map: PAYMENT_EXCEPTION_REASON,
            width: 130,
          }),
          enumColumn<PaymentExceptionListItem, PaymentExceptionListItem['status']>({
            title: '状态',
            dataIndex: 'status',
            map: PAYMENT_EXCEPTION_STATUS,
            width: 110,
          }),
          codeColumn<PaymentExceptionListItem>({ title: '退款单号', dataIndex: 'refundNo' }),
          errorColumn<PaymentExceptionListItem>({
            title: '退款失败原因',
            summary: 'lastErrorSummary',
            detail: 'lastError',
            width: 260,
          }),
          textColumn<PaymentExceptionListItem>({
            title: '备注',
            dataIndex: 'note',
            ellipsis: true,
          }),
          instantColumn<PaymentExceptionListItem>({ title: '退款时间', dataIndex: 'refundedAt' }),
          instantColumn<PaymentExceptionListItem>({
            title: '发生时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<PaymentExceptionListItem>({
            width: 230,
            render: (row) => (
              <>
                <Button type="link" size="small" onClick={() => setDetailId(row.id)}>
                  详情
                </Button>
                <ExceptionActions row={row} handlers={handlers} />
              </>
            ),
          }),
        ]}
      />

      <ExceptionDrawer id={detailId} onClose={() => setDetailId(null)} handlers={handlers} />

      <ModalForm
        {...refundModal.props}
        title={`退款：${refundModal.record?.transactionId ?? ''}`}
        size="small"
        schema={paymentExceptionRefundBody}
        fields={[
          {
            kind: 'textarea',
            name: 'note',
            label: '备注',
            rows: 3,
            maxLength: 255,
            help: '只记在本条异常的处理记录里，不会发给微信。',
          },
        ]}
        route={paymentAdminExceptionRefund}
        toInput={(values) => ({
          params: { id: refundModal.record?.id ?? '' },
          body: values,
        })}
        invalidate={[paymentAdminExceptionList, paymentAdminExceptionDetail]}
        onSuccess={(detail) => tellOutcome(outcomeText(detail, 'refund'))}
        okText="确认退款"
        header={
          refundModal.record ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={
                <>
                  将退回 <MoneyText value={refundModal.record.paidAmount} />
                  ，使用固定退款单号
                  {refundModal.record.refundNo ? ` ${refundModal.record.refundNo}` : '（首次生成）'}
                  。
                </>
              }
            />
          ) : null
        }
      />

      <ModalForm
        {...ignoreModal.props}
        title={`忽略：${ignoreModal.record?.transactionId ?? ''}`}
        size="small"
        schema={paymentExceptionIgnoreBody}
        fields={[
          {
            kind: 'textarea',
            name: 'note',
            label: '原因',
            rows: 3,
            maxLength: 255,
            required: true,
            help: '必填。忽略表示这笔钱不退，日后对账时这条说明就是唯一的解释。',
          },
        ]}
        route={paymentAdminExceptionIgnore}
        toInput={(values) => ({
          params: { id: ignoreModal.record?.id ?? '' },
          body: values,
        })}
        invalidate={[paymentAdminExceptionList, paymentAdminExceptionDetail]}
        successMessage="已忽略"
        okText="确认忽略"
      />
    </PageContainer>
  );
}

/**
 * What the toast says after 退款 or 查询结果: the status the row is in now, not
 * that a button was pressed (AGENTS.md rule 12). A refund WeChat refused is a
 * warning with its Chinese reason, never 已发起退款.
 */
export function outcomeText(detail: PaymentExceptionDetail, action: 'refund' | 'recheck'): Outcome {
  const why = detail.lastErrorSummary ? `：${detail.lastErrorSummary}` : '';
  switch (detail.status) {
    case 'refunded':
      return { level: 'success', text: '已退款' };
    case 'refunding':
      return {
        level: 'info',
        text:
          action === 'refund'
            ? '退款已提交，微信还在处理，稍后可点「查询结果」'
            : '微信还在处理这笔退款',
      };
    case 'refund_failed':
      return { level: 'warning', text: `退款没有成功${why}` };
    case 'refund_unknown':
      return { level: 'warning', text: `微信还没有给出退款结果${why}` };
    case 'ignored':
      return { level: 'info', text: '这条异常已被忽略，没有退款' };
    case 'open':
      return { level: 'info', text: '这条异常还没有退款' };
  }
}

/** Re-driving the refund is for a row where money has not gone back yet. */
function canRefund(status: PaymentExceptionListItem['status']): boolean {
  return status === 'open' || status === 'refund_failed' || status === 'refund_unknown';
}

/** Asking WeChat is only meaningful once a refund exists to ask about. */
function canRecheck(status: PaymentExceptionListItem['status']): boolean {
  return status === 'refunding' || status === 'refund_unknown';
}

/**
 * The drawer shows what the list cannot: the notification context as it
 * arrived (trade type, openid, client ip), why the refund has not gone back in
 * Chinese, and — under 技术详情 — whatever the gateway last said, as raw JSON.
 * The raw parts are evidence, and prettifying evidence loses the field nobody
 * thought to render; they are for the technician, so they sit behind the
 * Chinese line.
 */
function ExceptionDrawer({
  id,
  onClose,
  handlers,
}: {
  id: string | null;
  onClose: () => void;
  handlers: ExceptionActionHandlers;
}) {
  const detail = useRouteQuery(
    paymentAdminExceptionDetail,
    id === null ? undefined : { params: { id } },
    { enabled: id !== null, presentError: false },
  );
  const mayHandle = useCan()('payment:exception:handle');

  return (
    <DetailDrawer
      open={id !== null}
      onClose={onClose}
      title={`异常支付 #${id ?? ''}`}
      query={detail}
      footer={
        mayHandle ? (row) => <ExceptionActions row={row} handlers={handlers} inDrawer /> : undefined
      }
    >
      {(row) => (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <DescriptionsCard
            title="基本信息"
            column={2}
            items={[
              {
                label: '状态',
                value: <StatusTag value={row.status} map={PAYMENT_EXCEPTION_STATUS} />,
              },
              {
                label: '原因',
                value: <StatusTag value={row.reason} map={PAYMENT_EXCEPTION_REASON} />,
              },
              { label: '到账金额', value: <MoneyText value={row.paidAmount} /> },
              { label: '商户号', value: row.mchId },
              { label: '微信单号', value: <CodeText value={row.transactionId} />, span: 2 },
              {
                label: '商户单号',
                value: <CodeText value={row.outTradeNo ?? undefined} />,
                span: 2,
              },
              {
                label: '订单',
                value:
                  row.orderNo === null ? (
                    '无法匹配'
                  ) : (
                    <CodeText
                      value={row.orderNo}
                      href={row.orderId === null ? undefined : `/admin/orders/${row.orderId}`}
                    />
                  ),
              },
              { label: '退款单号', value: <CodeText value={row.refundNo ?? undefined} /> },
              { label: '退款时间', value: <InstantText value={row.refundedAt ?? undefined} /> },
              { label: '处理时间', value: <InstantText value={row.resolvedAt ?? undefined} /> },
              { label: '备注', value: row.note ?? '—', span: 2 },
            ]}
          />
          <DescriptionsCard
            title="到账上下文"
            column={1}
            items={[{ label: '通知内容', value: <Json value={row.context} /> }]}
          />
          <DescriptionsCard
            title="退款请求"
            column={1}
            items={[
              {
                label: '失败原因',
                value: <ErrorSummary summary={row.lastErrorSummary} detail={row.lastError} />,
              },
              {
                label: '技术详情',
                value:
                  row.refundRequest === null ? (
                    '—'
                  ) : (
                    <Collapse
                      ghost
                      size="small"
                      items={[
                        {
                          key: 'raw',
                          label: '展开（供技术人员排查）',
                          children: <Json value={row.refundRequest} />,
                        },
                      ]}
                    />
                  ),
              },
            ]}
          />
        </Space>
      )}
    </DetailDrawer>
  );
}

interface ExceptionActionHandlers {
  refund: (row: PaymentExceptionListItem) => void;
  ignore: (row: PaymentExceptionListItem) => void;
}

/**
 * What can be done to an exception, the same in its row and at the foot of
 * its drawer — where the operator has just read what WeChat said. Reversed
 * in the drawer so 退款, the primary action, is right-most.
 */
function ExceptionActions({
  row,
  handlers,
  inDrawer = false,
}: {
  row: PaymentExceptionListItem;
  handlers: ExceptionActionHandlers;
  inDrawer?: boolean;
}) {
  const can = useCan();
  const tellOutcome = useOutcomeToast();
  if (!can('payment:exception:handle')) return null;
  const look = inDrawer ? {} : ({ type: 'link', size: 'small' } as const);
  const items: ReactNode[] = [];
  if (canRefund(row.status)) {
    items.push(
      <Button
        key="refund"
        {...look}
        {...(inDrawer ? { type: 'primary' as const } : {})}
        onClick={() => handlers.refund(row)}
      >
        退款
      </Button>,
    );
  }
  if (canRecheck(row.status)) {
    items.push(
      <ConfirmButton
        key="recheck"
        route={paymentAdminExceptionRecheck}
        input={{ params: { id: row.id } }}
        title="向微信查询这笔退款的结果？"
        description="只查询，不会重新发起退款。"
        invalidate={[paymentAdminExceptionList, paymentAdminExceptionDetail]}
        onSuccess={(detail) => tellOutcome(outcomeText(detail, 'recheck'))}
        buttonProps={look}
      >
        查询结果
      </ConfirmButton>,
    );
  }
  if (row.status === 'open') {
    items.push(
      <Button key="ignore" {...look} onClick={() => handlers.ignore(row)}>
        忽略
      </Button>,
    );
  }
  if (items.length === 0) return null;
  return <>{inDrawer ? items.reverse() : items}</>;
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Typography.Paragraph style={{ marginBottom: 0 }}>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </Typography.Paragraph>
  );
}
