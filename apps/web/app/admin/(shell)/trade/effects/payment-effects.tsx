'use client';

import { Alert, Typography } from 'antd';
import {
  paymentAdminEffectList,
  paymentAdminEffectRetry,
} from '@shop/contracts/payment/payment.admin.contract';
import type { PaymentEffectListItem, PaymentEffectScope } from '@shop/contracts/payment/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { queuedRetryOutcome, useOutcomeToast } from '@/admin/kit/outcome-toast';
import { PageContainer } from '@/admin/kit/page-container';
import {
  actionsColumn,
  enumColumn,
  errorColumn,
  idColumn,
  instantColumn,
} from '@/admin/kit/table/columns';
import type { StatusMap } from '@/admin/kit/status-tag';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { EFFECT_STATUS, optionsOf } from '../trade-enums';

/**
 * 待处理任务 — the side effects that gave up.
 *
 * Every third-party call in the system happens *after* its transaction commits,
 * through the effects ledger: the database row and the money move together, and
 * the WeChat call follows. Delivery is at-least-once and handlers are
 * idempotent, so a transient failure costs a retry and nothing else.
 *
 * A row reaches 需人工处理 only after the ledger's own retries ran out. That is
 * what this screen lists, and the one that matters most is
 * `refund.execute` — the effect that sends money back to a buyer. A parked
 * `refund.execute` is somebody waiting for a refund that will never leave on
 * its own.
 *
 * 重试 does not run the handler here. It puts the row back to 待执行 with
 * `next_run_at = now`, and the dispatcher picks it up within five seconds — a
 * handler that calls WeChat has no business on an admin request thread, where
 * a slow gateway would look like a broken console. The update is conditional on
 * the row still being parked, so two operators pressing it at the same time
 * produce one re-queue and one warning that the row is already on its way
 * (`retryMessage`) — the toast says which, never 已重新排队 for both.
 *
 * The list covers every scope whose parked row is work left undone
 * (`paymentEffectScopes`): money, refunds, orders, the WeChat 发货信息录入,
 * group-buy and presale settlement, content security and WeChat's pushes. The
 * notification send log has its own screen.
 */

const EFFECT_SCOPE: StatusMap<PaymentEffectScope> = {
  payment: { label: '支付', color: 'gold' },
  refund: { label: '退款', color: 'orange' },
  order: { label: '订单', color: 'blue' },
  shipment: { label: '发货', color: 'cyan' },
  groupbuy: { label: '拼团', color: 'purple' },
  presale: { label: '预售', color: 'geekblue' },
  'content-security': { label: '内容安全', color: 'default' },
  'wechat-mini-push': { label: '微信推送', color: 'green' },
};

/** What each task does, in words; an event not listed here shows its code. */
const EVENT_LABELS: Record<string, string> = {
  'refund.execute': '发起退款',
  'payment.exception.refund': '异常支付原路退回',
  'order.paid': '订单支付后续处理',
  'order.refunded': '订单退款后续处理',
  'order.received': '确认收货后续处理',
  'order.completed': '订单完成后续处理',
  'order.auto-deliver': '虚拟商品自动发货',
  'shipment.dispatched': '发货后续处理',
  'wechat.uploadShipping': '录入微信发货信息',
  'wechat.correctShipping': '修改微信发货信息',
  'groupbuy.join': '拼团参团',
  'groupbuy.settle': '拼团成团结算',
  'groupbuy.refund': '拼团失败退款',
  'groupbuy.expire': '拼团超时处理',
  'presale.paid': '预售支付后续处理',
  'presale.refund': '预售退款',
  'presale.released': '预售名额退回',
  'presale.opened': '预售开售',
  'presale.closed': '预售结束',
  'wechat.mediaCheck': '提交微信内容安全检测',
  trade_manage_order_settlement: '微信确认收货 / 结算推送',
  trade_manage_remind_shipping: '微信发货提醒推送',
  trade_manage_remind_access_api: '微信发货信息管理接入推送',
  wxa_media_check: '微信内容安全结果推送',
};
export function PaymentEffectsPage() {
  const tellOutcome = useOutcomeToast();
  return (
    <PageContainer subTitle="重试用尽后停下来的异步任务；重试只是重新排队，真正的执行由后台完成">
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="这里的每一条都意味着某个动作没有做完——退款没发出、微信发货信息没录入、拼团没结算。先看错误信息，修好外部原因再重试。"
      />
      <CrudTable
        route={paymentAdminEffectList}
        scrollX={1300}
        defaultPageSize={20}
        filters={[
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            allowClear: false,
            options: optionsOf(EFFECT_STATUS),
          },
          {
            kind: 'select',
            name: 'scope',
            label: '范围',
            options: optionsOf(EFFECT_SCOPE),
          },
          { kind: 'text', name: 'eventType', label: '事件' },
        ]}
        columns={[
          idColumn<PaymentEffectListItem>(),
          enumColumn<PaymentEffectListItem, PaymentEffectScope>({
            title: '范围',
            dataIndex: 'scope',
            map: EFFECT_SCOPE,
            width: 100,
          }),
          {
            title: '事件',
            key: 'event',
            width: 260,
            render: (_value: unknown, row: PaymentEffectListItem) => (
              <Typography.Text>
                {EVENT_LABELS[row.eventType] ?? row.eventType}
                <Typography.Text type="secondary"> #{row.scopeId}</Typography.Text>
              </Typography.Text>
            ),
          },
          enumColumn<PaymentEffectListItem, PaymentEffectListItem['status']>({
            title: '状态',
            dataIndex: 'status',
            map: EFFECT_STATUS,
            width: 120,
          }),
          {
            title: '已尝试',
            dataIndex: 'attempts',
            key: 'attempts',
            width: 90,
            align: 'right' as const,
          },
          errorColumn<PaymentEffectListItem>({
            title: '错误信息',
            summary: 'lastErrorSummary',
            detail: 'lastError',
            width: 320,
          }),
          instantColumn<PaymentEffectListItem>({ title: '下次执行', dataIndex: 'nextRunAt' }),
          instantColumn<PaymentEffectListItem>({ title: '更新时间', dataIndex: 'updatedAt' }),
          actionsColumn<PaymentEffectListItem>({
            width: 110,
            render: (row) =>
              row.status === 'unknown' ? (
                <ConfirmButton
                  route={paymentAdminEffectRetry}
                  input={{ params: { id: row.id } }}
                  title="重新排队执行这个任务？"
                  description="任务会在几秒内由后台执行；重复执行是安全的。"
                  invalidate={[paymentAdminEffectList]}
                  onSuccess={(result) =>
                    tellOutcome(
                      queuedRetryOutcome({
                        succeeded: result.succeeded,
                        message: result.message,
                        status: result.effect.status,
                        lastErrorSummary: result.effect.lastErrorSummary,
                      }),
                    )
                  }
                  permission="payment:effect:handle"
                  buttonProps={{ type: 'link', size: 'small' }}
                >
                  重试
                </ConfirmButton>
              ) : null,
          }),
        ]}
      />
    </PageContainer>
  );
}
