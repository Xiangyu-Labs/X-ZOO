'use client';

import { Alert, Button, Descriptions, Space, Table, Tag, Timeline, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  refundAdminApprove,
  refundAdminDetail,
  refundAdminList,
  refundAdminReceiveReturn,
  refundAdminReject,
  refundAdminRemark,
  refundAdminRetry,
  refundAdminWithdraw,
} from '@shop/contracts/refund/refund.admin.contract';
import {
  adminRefundWithdrawBody,
  refundApproveBody,
  refundRejectBody,
  refundRemarkBody,
  type AdminRefundDetail,
  type AdminRefundListItem,
  type RefundItem,
} from '@shop/contracts/refund/schemas';
import { z } from 'zod';

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
  codeColumn,
  codeWidth,
  enumColumn,
  errorColumn,
  idColumn,
  instantColumn,
  moneyColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { useUrlDetailId } from '@/admin/kit/table/url-state';
import { Thumbnail, ThumbnailGroup } from '@/admin/kit/thumbnail';
import { useCan } from '@/admin/session/session-provider';

import { REFUND_KIND, REFUND_RETURN_STAGE, REFUND_STATUS, optionsOf } from '../trade-enums';

/**
 * 售后单 — the review desk.
 *
 * The order of the buttons is the order of the decisions, and they are
 * deliberately different decisions with different permissions:
 *
 *  - **同意 / 拒绝** (`refund:request:review`) say whether the customer is owed
 *    money. Approving a 仅退款 queues the gateway call immediately; approving a
 *    退货退款 only asks the buyer to ship the goods back. Both dialogs repeat
 *    the amount and the buyer's reason, so nobody decides from the row alone.
 *  - **关闭** (`refund:request:review`) is 拒绝 on a refund WeChat refused: it
 *    still holds its lines while 重试 could pay it (REFUND-017), and closing it
 *    — settled by hand, say — frees them.
 *  - **确认收货** (`refund:request:execute`) says the goods arrived, and *that*
 *    is what releases the money on a 退货退款.
 *  - **撤销** (`refund:request:review`) takes back a 退货退款 the shop opened
 *    itself (订单详情 → 发起售后) while the goods have not been sent. A buyer's
 *    request is never the shop's to withdraw; it is 拒绝d.
 *  - **重试** (`refund:request:execute`) re-drives a refund that failed or came
 *    back unknown. It asks WeChat about the **frozen** `outRefundNo` and never
 *    mints a new one — a retry with a fresh number is how a buyer is refunded
 *    twice (REFUND-005).
 *
 * In a shop where customer service approves and finance pays, that split is the
 * control. In a small shop one person holds both atoms, which is a grant, not a
 * code change.
 *
 * There is no amount field anywhere on this page. The amount was computed from
 * the frozen order lines when the request was made and is never recomputed; an
 * operator typing one is how a shop refunds more than it was paid
 * (`REFUND_EXCEEDS_PAID` exists because the database refuses it too).
 *
 * The return address comes from 售后设置 and is frozen on the request when a
 * 退货退款 is approved: editing 售后设置 afterwards does not re-address a parcel
 * already in the post. Whoever may change 售后设置 (`refund:config:write`) may
 * also send this one return elsewhere from the 同意 dialog; a reviewer alone
 * may not, because redirecting goods is not a review decision.
 *
 * Every action refreshes the list *and* the open drawer (`REFRESHES`), so the
 * drawer never shows the status from before the operator's own click.
 */
const REFRESHES = [refundAdminList, refundAdminDetail] as const;

const RETURN_FIELDS = [
  ['returnName', '收件人'],
  ['returnPhone', '联系电话'],
  ['returnAddress', '退货地址'],
] as const;

/**
 * The 同意 dialog's own shape: the contract's nested `returnAddress` as three
 * flat inputs, so a blank one is simply absent. All three or none — none means
 * 售后设置's address.
 */
const approveForm = refundApproveBody
  .omit({ returnAddress: true })
  .extend({
    returnName: z.string().max(32).optional(),
    returnPhone: z.string().max(20).optional(),
    returnAddress: z.string().max(255).optional(),
  })
  .superRefine((values, ctx) => {
    const missing = RETURN_FIELDS.filter(([key]) => values[key] === undefined);
    if (missing.length === 0 || missing.length === RETURN_FIELDS.length) return;
    for (const [key, label] of missing) {
      ctx.addIssue({ code: 'custom', path: [key], message: `请填写${label}` });
    }
  });

type ApproveForm = z.output<typeof approveForm>;

function approveBody({ returnName, returnPhone, returnAddress, ...rest }: ApproveForm) {
  if (returnName === undefined || returnPhone === undefined || returnAddress === undefined) {
    return rest;
  }
  return {
    ...rest,
    returnAddress: { name: returnName, phone: returnPhone, address: returnAddress },
  };
}

export function RefundRequestsPage() {
  // `?detail=<id>` is what the admin notification links to (NOTIF-008).
  const [detailId, setDetailId] = useUrlDetailId();
  const approveModal = useFormModal<AdminRefundListItem>();
  const rejectModal = useFormModal<AdminRefundListItem>();
  const remarkModal = useFormModal<AdminRefundListItem>();
  const withdrawModal = useFormModal<AdminRefundListItem>();
  const can = useCan();
  const redirectsReturn =
    approveModal.record?.kind === 'return_and_refund' && can('refund:config:write');
  const handlers: RefundActionHandlers = {
    approve: (row) => approveModal.show(row),
    reject: (row) => rejectModal.show(row),
    withdraw: (row) => withdrawModal.show(row),
    remark: (row) => remarkModal.show(row),
  };

  return (
    <PageContainer subTitle="买家发起的退款与退货退款；金额在申请时已冻结，这里只决定同不同意">
      <CrudTable
        route={refundAdminList}
        scrollX={1700}
        filters={[
          { kind: 'text', name: 'keyword', label: '单号', placeholder: '售后单号或订单号' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: optionsOf(REFUND_STATUS),
          },
          { kind: 'select', name: 'kind', label: '类型', options: optionsOf(REFUND_KIND) },
          {
            kind: 'select',
            name: 'returnStage',
            label: '退货进度',
            options: optionsOf(REFUND_RETURN_STAGE),
          },
          { kind: 'number', name: 'userId', label: '用户 ID' },
          { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '申请时间' },
        ]}
        columns={[
          idColumn<AdminRefundListItem>({ sortable: true }),
          {
            title: '售后单号',
            dataIndex: 'refundNo',
            key: 'refundNo',
            // Room for the 系统 tag too.
            width: codeWidth(26) + 48,
            render: (value: unknown, row: AdminRefundListItem) => (
              <Space size={6} style={{ whiteSpace: 'nowrap' }}>
                <CodeText value={String(value)} />
                {row.isAutomatic ? (
                  <Tag color="gold" bordered={false}>
                    系统
                  </Tag>
                ) : null}
                {row.initiatedByAdminId !== null ? (
                  <Tag color="blue" bordered={false}>
                    商家
                  </Tag>
                ) : null}
              </Space>
            ),
          },
          codeColumn<AdminRefundListItem>({
            title: '订单号',
            dataIndex: 'orderNo',
            href: (row) => `/admin/orders/${row.orderId}`,
          }),
          {
            title: '买家',
            key: 'user',
            width: 150,
            render: (_value: unknown, row: AdminRefundListItem) => (
              <Typography.Text>
                {row.userNickname ?? '—'}
                <Typography.Text type="secondary"> #{row.userId}</Typography.Text>
              </Typography.Text>
            ),
          },
          enumColumn<AdminRefundListItem, AdminRefundListItem['kind']>({
            title: '类型',
            dataIndex: 'kind',
            map: REFUND_KIND,
            width: 110,
          }),
          moneyColumn<AdminRefundListItem>({
            title: '申请金额',
            dataIndex: 'amount',
            sortable: true,
          }),
          moneyColumn<AdminRefundListItem>({ title: '已退', dataIndex: 'refundedAmount' }),
          enumColumn<AdminRefundListItem, AdminRefundListItem['status']>({
            title: '状态',
            dataIndex: 'status',
            map: REFUND_STATUS,
            width: 110,
          }),
          enumColumn<AdminRefundListItem, AdminRefundListItem['returnStage']>({
            title: '退货进度',
            dataIndex: 'returnStage',
            map: REFUND_RETURN_STAGE,
            width: 130,
          }),
          errorColumn<AdminRefundListItem>({
            title: '最后错误',
            summary: 'lastErrorSummary',
            detail: 'lastError',
            width: 280,
          }),
          instantColumn<AdminRefundListItem>({
            title: '申请时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<AdminRefundListItem>({
            width: 260,
            render: (row) => (
              <>
                <Button type="link" size="small" onClick={() => setDetailId(row.id)}>
                  详情
                </Button>
                <RefundActions row={row} handlers={handlers} />
              </>
            ),
          }),
        ]}
      />

      <RefundDrawer id={detailId} onClose={() => setDetailId(null)} handlers={handlers} />

      <ModalForm
        {...approveModal.props}
        title={`同意退款：${approveModal.record?.refundNo ?? ''}`}
        size="small"
        schema={approveForm}
        fields={[
          {
            kind: 'textarea',
            name: 'remark',
            label: '备注',
            rows: 3,
            maxLength: 255,
            help: '会写进售后单的处理记录，买家可以看到。',
          },
          ...(redirectsReturn
            ? ([
                { kind: 'text', name: 'returnName', label: '收件人', maxLength: 32, span: 12 },
                { kind: 'text', name: 'returnPhone', label: '联系电话', maxLength: 20, span: 12 },
                {
                  kind: 'textarea',
                  name: 'returnAddress',
                  label: '退货地址',
                  rows: 2,
                  maxLength: 255,
                  help: '三项都留空则用「售后设置」里的地址；填写后只对这一单生效，买家会看到。',
                },
              ] as const)
            : []),
        ]}
        route={refundAdminApprove}
        toInput={(values) => ({
          params: { id: approveModal.record?.id ?? '' },
          body: approveBody(values),
        })}
        invalidate={REFRESHES}
        successMessage="已同意"
        okText="确认同意"
        header={
          approveModal.record ? (
            <>
              <RequestSummary record={approveModal.record} />
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={
                  approveModal.record.kind === 'refund_only' ? (
                    <>
                      同意后立即退回 <MoneyText value={approveModal.record.amount} />。
                    </>
                  ) : (
                    <>
                      同意后买家按「售后设置」里的退货地址寄回，确认收货时才退款
                      <MoneyText value={approveModal.record.amount} />。
                      {redirectsReturn ? '要寄到别处时在下方填写本单的退货地址；' : ''}
                      退货地址未填写时无法同意。
                    </>
                  )
                }
              />
            </>
          ) : null
        }
      />

      <ModalForm
        {...rejectModal.props}
        title={`${rejectModal.record?.status === 'failed' ? '关闭售后' : '拒绝退款'}：${rejectModal.record?.refundNo ?? ''}`}
        size="small"
        schema={refundRejectBody}
        fields={[
          {
            kind: 'textarea',
            name: 'rejectReason',
            label: '拒绝原因',
            rows: 3,
            maxLength: 255,
            required: true,
            help: '必填，买家会原样看到这句话。',
          },
        ]}
        route={refundAdminReject}
        toInput={(values) => ({ params: { id: rejectModal.record?.id ?? '' }, body: values })}
        invalidate={REFRESHES}
        successMessage={rejectModal.record?.status === 'failed' ? '已关闭' : '已拒绝'}
        okText={rejectModal.record?.status === 'failed' ? '确认关闭' : '确认拒绝'}
        header={
          rejectModal.record ? (
            <>
              <RequestSummary record={rejectModal.record} />
              {rejectModal.record.status === 'failed' ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="微信未退款成功。关闭后这笔售后不再重试，商品可重新发货，买家可重新申请；已线下退款的请在原因里写明。"
                />
              ) : null}
            </>
          ) : null
        }
      />

      <ModalForm
        {...withdrawModal.props}
        title={`撤销售后：${withdrawModal.record?.refundNo ?? ''}`}
        size="small"
        schema={adminRefundWithdrawBody}
        fields={[
          {
            kind: 'textarea',
            name: 'reason',
            label: '撤销原因',
            rows: 3,
            maxLength: 255,
            required: true,
            help: '必填，买家会在售后详情里看到。',
          },
        ]}
        route={refundAdminWithdraw}
        toInput={(values) => ({ params: { id: withdrawModal.record?.id ?? '' }, body: values })}
        invalidate={REFRESHES}
        successMessage="已撤销"
        okText="确认撤销"
        okDanger
        header={
          withdrawModal.record ? (
            <>
              <RequestSummary record={withdrawModal.record} />
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message="撤销后这笔售后结束，不会退款；买家无需再寄回商品。"
              />
            </>
          ) : null
        }
      />

      <ModalForm
        {...remarkModal.props}
        title={`备注：${remarkModal.record?.refundNo ?? ''}`}
        size="small"
        schema={refundRemarkBody}
        fields={[
          {
            kind: 'textarea',
            name: 'adminRemark',
            label: '内部备注',
            rows: 3,
            maxLength: 255,
            help: '只在后台可见。',
          },
        ]}
        initialValues={
          remarkModal.record?.adminRemark === null || remarkModal.record === undefined
            ? undefined
            : { adminRemark: remarkModal.record.adminRemark ?? '' }
        }
        route={refundAdminRemark}
        toInput={(values) => ({ params: { id: remarkModal.record?.id ?? '' }, body: values })}
        invalidate={REFRESHES}
        successMessage="已保存"
      />
    </PageContainer>
  );
}

/**
 * What the operator is deciding on, repeated in the dialog: the amount, what
 * kind of request, how many units and the buyer's own reason.
 */
function RequestSummary({ record }: { record: AdminRefundListItem }) {
  return (
    <Descriptions
      size="small"
      column={2}
      bordered
      style={{ marginBottom: 16 }}
      items={[
        { key: 'amount', label: '申请金额', children: <MoneyText value={record.amount} /> },
        {
          key: 'kind',
          label: '类型',
          children: <StatusTag value={record.kind} map={REFUND_KIND} />,
        },
        { key: 'quantity', label: '件数', children: record.quantity },
        { key: 'freight', label: '含运费', children: record.includesFreight ? '是' : '否' },
        {
          key: 'reason',
          label: record.initiatedByAdminId === null ? '买家原因' : '售后原因',
          span: 2,
          children: record.reason ?? '—',
        },
      ]}
    />
  );
}

interface RefundActionHandlers {
  approve: (row: AdminRefundListItem) => void;
  reject: (row: AdminRefundListItem) => void;
  withdraw: (row: AdminRefundListItem) => void;
  remark: (row: AdminRefundListItem) => void;
}

/**
 * What can be done to a refund, offered the same way in its table row and at
 * the foot of its drawer — the operator who opened the drawer to read the
 * buyer's photos decides there, without closing it to find the row again. In
 * the drawer the order is reversed so 同意 is the right-most, primary button.
 */
function RefundActions({
  row,
  handlers,
  inDrawer = false,
}: {
  row: AdminRefundListItem;
  handlers: RefundActionHandlers;
  inDrawer?: boolean;
}) {
  const can = useCan();
  const tellOutcome = useOutcomeToast();
  const look = inDrawer ? {} : ({ type: 'link', size: 'small' } as const);
  const items: ReactNode[] = [];

  if (can('refund:request:review')) {
    if (row.status === 'applied') {
      items.push(
        <Button
          key="approve"
          {...look}
          {...(inDrawer ? { type: 'primary' as const } : {})}
          onClick={() => handlers.approve(row)}
        >
          同意
        </Button>,
        <Button key="reject" {...look} danger onClick={() => handlers.reject(row)}>
          拒绝
        </Button>,
      );
    }
    if (row.status === 'failed') {
      items.push(
        <Button key="close" {...look} danger onClick={() => handlers.reject(row)}>
          关闭
        </Button>,
      );
    }
    if (shopMayWithdraw(row)) {
      items.push(
        <Button key="withdraw" {...look} danger onClick={() => handlers.withdraw(row)}>
          撤销
        </Button>,
      );
    }
  }
  if (can('refund:request:execute')) {
    if (row.returnStage === 'shipped_back') {
      items.push(
        <ConfirmButton
          key="receive"
          route={refundAdminReceiveReturn}
          input={{ params: { id: row.id }, body: {} }}
          title="确认已收到退货？"
          description="确认后立即向微信发起退款。"
          invalidate={REFRESHES}
          successMessage="已确认收货"
          buttonProps={inDrawer ? { type: 'primary' } : look}
        >
          确认收货
        </ConfirmButton>,
      );
    }
    if (canRetry(row.status)) {
      items.push(
        <ConfirmButton
          key="retry"
          route={refundAdminRetry}
          input={{ params: { id: row.id } }}
          title="重新处理这笔退款？"
          description="使用原有的商户退款单号，不会重复退款；商品已发出的无法重试。"
          invalidate={REFRESHES}
          onSuccess={(detail) => tellOutcome(refundRetryOutcome(detail))}
          buttonProps={look}
        >
          重试
        </ConfirmButton>,
      );
    }
  }
  if (can('refund:request:write')) {
    items.push(
      <Button key="remark" {...look} onClick={() => handlers.remark(row)}>
        备注
      </Button>,
    );
  }

  if (items.length === 0) return null;
  return <>{inDrawer ? items.reverse() : items}</>;
}

/**
 * What 重试 found, from the refund as it stands afterwards: the retry asks
 * WeChat (or sends the refund again) before it answers, so the toast says how
 * it came out — a refund WeChat refused again is not 已重新处理.
 */
export function refundRetryOutcome(detail: AdminRefundDetail): Outcome {
  const why = detail.lastErrorSummary ? `：${detail.lastErrorSummary}` : '';
  switch (detail.status) {
    case 'succeeded':
      return { level: 'success', text: '已退款' };
    case 'processing':
      return { level: 'info', text: '微信还在处理这笔退款，稍后可以再点「重试」查询结果' };
    case 'failed':
      return { level: 'warning', text: `退款没有成功${why}` };
    case 'unknown':
      return { level: 'warning', text: `微信还没有给出退款结果${why}` };
    default:
      return { level: 'info', text: '这笔售后当前不需要退款' };
  }
}

/**
 * 撤销 is for a 退货退款 the shop opened, before the goods are sent — the
 * server's `shopMayWithdraw`.
 */
export function shopMayWithdraw(row: AdminRefundListItem): boolean {
  return (
    row.initiatedByAdminId !== null &&
    row.status === 'approved' &&
    row.kind === 'return_and_refund' &&
    row.returnStage === 'awaiting_shipment'
  );
}

/** Retrying is for a refund that tried and did not land. */
function canRetry(status: AdminRefundListItem['status']): boolean {
  return status === 'failed' || status === 'unknown' || status === 'processing';
}

/**
 * The drawer answers the two questions the list cannot: *what* is being
 * refunded, and *what happened so far*. The timeline is the refund's log table,
 * which is written in the same transaction as every status change — so it can
 * never disagree with the status next to it.
 */
function RefundDrawer({
  id,
  onClose,
  handlers,
}: {
  id: string | null;
  onClose: () => void;
  handlers: RefundActionHandlers;
}) {
  const detail = useRouteQuery(refundAdminDetail, id === null ? undefined : { params: { id } }, {
    enabled: id !== null,
    presentError: false,
  });
  const can = useCan();
  const mayAct =
    can('refund:request:review') || can('refund:request:execute') || can('refund:request:write');

  return (
    <DetailDrawer
      open={id !== null}
      onClose={onClose}
      size="large"
      title={(row) => `售后单 ${row?.refundNo ?? ''}`}
      query={detail}
      footer={
        mayAct ? (row) => <RefundActions row={row} handlers={handlers} inDrawer /> : undefined
      }
    >
      {(row) => (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <DescriptionsCard
            title="基本信息"
            column={2}
            items={[
              { label: '状态', value: <StatusTag value={row.status} map={REFUND_STATUS} /> },
              { label: '类型', value: <StatusTag value={row.kind} map={REFUND_KIND} /> },
              {
                label: '退货进度',
                value: <StatusTag value={row.returnStage} map={REFUND_RETURN_STAGE} />,
              },
              { label: '含运费', value: row.includesFreight ? '是' : '否' },
              { label: '申请金额', value: <MoneyText value={row.amount} /> },
              { label: '已退金额', value: <MoneyText value={row.refundedAmount} /> },
              {
                label: '订单号',
                value: <CodeText value={row.orderNo} href={`/admin/orders/${row.orderId}`} />,
              },
              { label: '买家', value: `${row.userNickname ?? '—'} #${row.userId}` },
              {
                label: '发起人',
                value: `商家发起 · ${row.initiatedByAdminName ?? `管理员 #${row.initiatedByAdminId ?? ''}`}`,
                span: 2,
                hidden: row.initiatedByAdminId === null,
              },
              { label: '商户退款单号', value: <CodeText value={row.outRefundNo} />, span: 2 },
              {
                label: '微信退款单号',
                value: <CodeText value={row.gatewayRefundId ?? undefined} />,
                span: 2,
              },
              { label: '申请原因', value: row.reason ?? '—', span: 2 },
              { label: '补充说明', value: row.explanation ?? '—', span: 2 },
              {
                label: '凭证图片',
                span: 2,
                value:
                  row.images.length > 0 ? (
                    <ThumbnailGroup urls={row.images} max={9} size={72} radius={4} />
                  ) : (
                    '买家没有上传'
                  ),
              },
              {
                label: '拒绝原因',
                value: row.rejectReason ?? '—',
                span: 2,
                hidden: row.rejectReason === null,
              },
              { label: '内部备注', value: row.adminRemark ?? '—', span: 2 },
              {
                label: '最后错误',
                value: <ErrorSummary summary={row.lastErrorSummary} detail={row.lastError} />,
                span: 2,
                hidden: row.lastError === null,
              },
              { label: '申请时间', value: <InstantText value={row.createdAt} /> },
              {
                label: '退款成功时间',
                value: <InstantText value={row.succeededAt ?? undefined} />,
              },
            ]}
          />

          {row.kind === 'return_and_refund' ? (
            <DescriptionsCard
              title="退货信息"
              column={2}
              items={[
                {
                  label: '退货地址',
                  span: 2,
                  value: row.returnAddress ? (
                    <Typography.Text copyable>
                      {`${row.returnAddress.name} ${row.returnAddress.phone} ${row.returnAddress.address}`}
                    </Typography.Text>
                  ) : row.status === 'applied' ? (
                    '同意时确定'
                  ) : (
                    '—'
                  ),
                },
                { label: '快递公司', value: row.returnExpressCompanyName ?? '—' },
                { label: '运单号', value: <CodeText value={row.returnTrackingNo ?? undefined} /> },
                { label: '联系电话', value: row.returnPhone ?? '—' },
              ]}
            />
          ) : null}

          <Table<RefundItem>
            size="small"
            rowKey={(item) => item.orderItemId}
            pagination={false}
            dataSource={row.items}
            columns={[
              {
                title: '商品',
                key: 'product',
                ellipsis: true,
                render: (_value: unknown, item: RefundItem) => (
                  <Space size={8}>
                    {item.productImageUrl ? (
                      <Thumbnail src={item.productImageUrl} size={40} />
                    ) : null}
                    <Typography.Text ellipsis>{item.productName}</Typography.Text>
                  </Space>
                ),
              },
              { title: '规格', dataIndex: 'specText', key: 'specText', width: 160, ellipsis: true },
              { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 80, align: 'right' },
              {
                title: '金额',
                dataIndex: 'amount',
                key: 'amount',
                width: 120,
                align: 'right',
                render: (value: unknown) =>
                  typeof value === 'string' ? <MoneyText value={value} /> : '—',
              },
            ]}
          />

          <Timeline
            mode="left"
            items={row.logs.map((log) => ({
              color: timelineColour(log.toStatus),
              children: (
                <Space direction="vertical" size={0}>
                  <Typography.Text>
                    <StatusTag value={log.toStatus} map={REFUND_STATUS} /> {log.message ?? ''}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    <InstantText value={log.createdAt} format="datetime" />
                  </Typography.Text>
                </Space>
              ),
            }))}
          />
        </Space>
      )}
    </DetailDrawer>
  );
}

function timelineColour(status: AdminRefundListItem['status']): string {
  if (status === 'succeeded') return 'green';
  if (status === 'failed' || status === 'unknown') return 'red';
  if (status === 'rejected' || status === 'cancelled') return 'gray';
  return 'blue';
}
