'use client';

import { Alert, App, Typography } from 'antd';
import {
  systemFailedJobList,
  systemFailedJobResolve,
} from '@shop/contracts/system/system.jobs.contract';
import type { FailedJobItem } from '@shop/contracts/system/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, errorColumn, idColumn, instantColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

/**
 * 失败的后台任务 — the worker's dead-letter box.
 *
 * A background job that failed every retry: an order sweep, a coupon expiry, a
 * reconciliation. Nothing is re-run from here — each sweep comes round again on
 * its own schedule — so the screen is for reading what went wrong and, once
 * the cause is fixed, marking the row 已处理 so 「异常待处理」 on the home page
 * counts only what is still open.
 */

/** What each job does, in words. A job not listed shows as 其他后台任务. */
export const JOB_LABELS: Record<string, string> = {
  'catalog.autoReview': '系统默认好评',
  'catalog.foldProductViews': '汇总商品浏览量',
  'catalog.pruneHistory': '清理浏览足迹',
  'coupon.closeClaimWindows': '关闭已过领取期的优惠券',
  'coupon.expireUserCoupons': '标记过期优惠券',
  'groupbuy.sweepEndedActivities': '结束到期的拼团活动',
  'groupbuy.sweepExpiredGroups': '处理超时未成团的拼团',
  'order.autoCancel': '自动取消未支付订单',
  'order.autoReceive': '自动确认收货',
  'order.complete': '订单自动完成',
  'order.sweepAutoReceive': '补扫自动确认收货',
  'order.sweepCompletions': '补扫订单自动完成',
  'order.sweepExpiredOrders': '补扫超时未支付订单',
  'payment.closeExpiredPayments': '关闭超时支付单',
  'payment.recheckExceptionRefunds': '核对异常支付退款结果',
  'payment.reconcileStalePayments': '核对支付状态',
  'presale.sweepWindows': '预售开售/结束',
  'refund.reconcileStaleRefunds': '核对退款结果',
  'storage.backfillImageVariants': '补生成图片缩略图',
  'storage.cleanOrphans': '清理已删除素材文件',
  'storage.generateImageVariants': '生成图片缩略图',
  'system.dispatchEffects': '执行异步任务',
  'system.heartbeat': '后台心跳',
  'system.pruneAuditLogs': '清理操作日志',
  'system.pruneEffects': '清理已完成的异步任务',
  'system.pruneSessions': '清理过期登录',
  'user.pruneVisits': '清理访问记录',
};

export function FailedJobsPage() {
  const { message } = App.useApp();
  return (
    <PageContainer subTitle="重试用尽仍失败的定时/后台任务；任务会按计划自动再次运行，修好原因后标记已处理">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="点「技术详情」可以复制后台原始信息发给技术人员。同一任务反复失败时，通常是数据库、网络或第三方接口的问题。"
      />
      <CrudTable
        route={systemFailedJobList}
        scrollX={1000}
        defaultPageSize={20}
        filters={[
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            allowClear: false,
            options: [
              { value: 'open', label: '待处理' },
              { value: 'resolved', label: '已处理' },
            ],
          },
        ]}
        columns={[
          idColumn<FailedJobItem>(),
          {
            title: '任务',
            key: 'jobName',
            width: 220,
            render: (_value: unknown, row: FailedJobItem) =>
              JOB_LABELS[row.jobName] ?? '其他后台任务',
          },
          instantColumn<FailedJobItem>({ title: '失败时间', dataIndex: 'createdAt', width: 180 }),
          {
            title: '已尝试',
            dataIndex: 'attempts',
            key: 'attempts',
            width: 90,
            align: 'right' as const,
          },
          errorColumn<FailedJobItem>({
            title: '失败原因',
            summary: 'errorSummary',
            detail: 'error',
            width: 320,
          }),
          instantColumn<FailedJobItem>({ title: '处理时间', dataIndex: 'resolvedAt', width: 180 }),
          actionsColumn<FailedJobItem>({
            width: 110,
            render: (row) =>
              row.resolvedAt === null ? (
                <ConfirmButton
                  route={systemFailedJobResolve}
                  input={{ params: { id: row.id } }}
                  title="标记为已处理？"
                  description="只是从待处理中移除，不会重新运行任务。"
                  invalidate={[systemFailedJobList]}
                  onSuccess={(result) => {
                    if (result.resolved) void message.success('已标记为已处理');
                    else void message.info('这条记录已被其他人处理');
                  }}
                  permission="system:job:handle"
                  buttonProps={{ type: 'link', size: 'small' }}
                >
                  标记已处理
                </ConfirmButton>
              ) : (
                <Typography.Text type="secondary">已处理</Typography.Text>
              ),
          }),
        ]}
      />
    </PageContainer>
  );
}
