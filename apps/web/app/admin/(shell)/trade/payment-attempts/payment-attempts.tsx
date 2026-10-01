'use client';

import { paymentAdminAttemptList } from '@shop/contracts/payment/payment.admin.contract';
import type { PaymentAttemptListItem } from '@shop/contracts/payment/schemas';

import { PageContainer } from '@/admin/kit/page-container';
import {
  CodeText,
  codeWidth,
  codeColumn,
  enumColumn,
  idColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { PAYMENT_ATTEMPT_STATUS, PAYMENT_CHANNEL, optionsOf } from '../trade-enums';

/**
 * 支付记录 — every attempt, including the ones that went nowhere.
 *
 * Read-only, and deliberately so: there is no button on this page that changes
 * an attempt, because every legitimate transition is either the gateway's
 * answer or a sweep acting on it. An operator who wants to *do* something about
 * an attempt is looking for the order, or for 异常支付.
 *
 * The filters are the three numbers support is ever given over the phone: the
 * order id, the merchant order number (`outTradeNo`) and WeChat's own
 * `transaction_id`. `outTradeNo` is the one that matters, because it is frozen
 * for the life of the attempt and is what we quote back to WeChat.
 *
 * `结果未知` is red and sorts to the operator's eye first. It is not a failure —
 * it means the gateway did not answer and the reconciliation sweep is still
 * asking. Nothing on this screen resolves it by guessing (PAYC-002).
 */
export function PaymentAttemptsPage() {
  return (
    <PageContainer subTitle="每一次发起支付的记录；结果只由微信的应答决定，这里不改状态">
      <CrudTable
        route={paymentAdminAttemptList}
        scrollX={1500}
        filters={[
          { kind: 'number', name: 'orderId', label: '订单 ID' },
          { kind: 'text', name: 'outTradeNo', label: '商户单号' },
          { kind: 'text', name: 'transactionId', label: '微信单号' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: optionsOf(PAYMENT_ATTEMPT_STATUS),
          },
          {
            kind: 'select',
            name: 'channel',
            label: '支付方式',
            options: optionsOf(PAYMENT_CHANNEL),
          },
          { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '创建时间' },
        ]}
        columns={[
          idColumn<PaymentAttemptListItem>({ sortable: true }),
          {
            title: '订单',
            key: 'order',
            width: codeWidth(26),
            render: (_value: unknown, row: PaymentAttemptListItem) => (
              <CodeText value={row.orderNo} href={`/admin/orders/${row.orderId}`} />
            ),
          },
          codeColumn<PaymentAttemptListItem>({ title: '商户单号', dataIndex: 'outTradeNo' }),
          moneyColumn<PaymentAttemptListItem>({
            title: '金额',
            dataIndex: 'amount',
            sortable: true,
          }),
          enumColumn<PaymentAttemptListItem, PaymentAttemptListItem['channel']>({
            title: '支付方式',
            dataIndex: 'channel',
            map: PAYMENT_CHANNEL,
          }),
          enumColumn<PaymentAttemptListItem, PaymentAttemptListItem['status']>({
            title: '状态',
            dataIndex: 'status',
            map: PAYMENT_ATTEMPT_STATUS,
          }),
          codeColumn<PaymentAttemptListItem>({
            title: '微信单号',
            dataIndex: 'transactionId',
            chars: 28,
          }),
          textColumn<PaymentAttemptListItem>({ title: '商户号', dataIndex: 'mchId' }),
          textColumn<PaymentAttemptListItem>({
            title: '最后结果',
            dataIndex: 'lastResult',
            ellipsis: true,
          }),
          instantColumn<PaymentAttemptListItem>({ title: '支付时间', dataIndex: 'paidAt' }),
          instantColumn<PaymentAttemptListItem>({
            title: '创建时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
        ]}
      />
    </PageContainer>
  );
}
