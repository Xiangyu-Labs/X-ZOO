'use client';

import { Space, Tag, Tooltip, Typography } from 'antd';
import {
  notificationAdminLogList,
  notificationAdminLogRetry,
} from '@shop/contracts/notification/notification.admin.contract';
import type { NotificationLog } from '@shop/contracts/notification/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { queuedRetryOutcome, useOutcomeToast } from '@/admin/kit/outcome-toast';
import { errorColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import {
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_CHANNEL_OUTCOME,
  NOTIFICATION_LOG_STATUS,
} from '../notification-enums';

/**
 * 发送记录 — the effects ledger, filtered to notifications.
 *
 * There is no `notification_logs` table. A notification *is* a row in `effects`,
 * so the send log reads that row: its attempt count, its next run, and its last
 * failure — in Chinese, with WeChat's own words under 技术详情. A second table
 * would be a second truth, and the one that governs whether the message goes
 * out is the ledger.
 *
 * The default filter is 需要处理 rather than 全部. A shop sends thousands of
 * these a day and every one of them succeeding is not news; the rows worth a
 * human's attention are the ones the dispatcher gave up on.
 *
 * 渠道 says, per channel, what the last attempt did — 已发送, 未发出 (with why
 * on hover: not configured, no provider, nobody to reach), 失败 or 未知 — so a
 * 已完成 row whose SMS never went out does not read as sent.
 */
export function NotificationLogsPage() {
  const tellOutcome = useOutcomeToast();
  return (
    <PageContainer subTitle="通知发送来自效果账本；默认只看需要处理的那些">
      <CrudTable
        route={notificationAdminLogList}
        scrollX={1400}
        filters={[
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            allowClear: false,
            options: Object.entries(NOTIFICATION_LOG_STATUS).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
          { kind: 'text', name: 'code', label: '事件编码' },
        ]}
        columns={[
          textColumn<NotificationLog>({ title: '事件', dataIndex: 'name', ellipsis: true }),
          textColumn<NotificationLog>({ title: '编码', dataIndex: 'code', width: 180 }),
          textColumn<NotificationLog>({ title: '对象', dataIndex: 'subject', width: 140 }),
          {
            title: '接收方',
            key: 'audience',
            width: 90,
            render: (_value: unknown, row: NotificationLog) => (
              <StatusTag value={row.audience} map={NOTIFICATION_AUDIENCE} />
            ),
          },
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: NotificationLog) => (
              <StatusTag value={row.status} map={NOTIFICATION_LOG_STATUS} />
            ),
          },
          {
            title: '渠道',
            key: 'channels',
            width: 340,
            render: (_value: unknown, row: NotificationLog) =>
              row.channels.length === 0 ? (
                <Typography.Text type="secondary">尚未发送</Typography.Text>
              ) : (
                <Space size={4} wrap>
                  {row.channels.map(({ channel, outcome, note }) => {
                    const { label, color } = NOTIFICATION_CHANNEL_OUTCOME[outcome];
                    return (
                      <Tooltip key={channel} title={note}>
                        <Tag color={color ?? 'default'} bordered={false}>
                          {NOTIFICATION_CHANNEL[channel].label} {label}
                        </Tag>
                      </Tooltip>
                    );
                  })}
                </Space>
              ),
          },
          { title: '尝试', dataIndex: 'attempts', key: 'attempts', width: 70 },
          errorColumn<NotificationLog>({
            title: '最后错误',
            summary: 'lastErrorSummary',
            detail: 'lastError',
            width: 320,
          }),
          instantColumn<NotificationLog>({ title: '下次执行', dataIndex: 'nextRunAt' }),
          instantColumn<NotificationLog>({ title: '创建时间', dataIndex: 'createdAt' }),
          {
            title: '操作',
            key: 'actions',
            width: 100,
            fixed: 'right' as const,
            render: (_value: unknown, row: NotificationLog) => (
              <ConfirmButton
                route={notificationAdminLogRetry}
                input={{ params: { id: row.id }, body: {} }}
                title="重新发送该通知？"
                // Worth saying out loud: the claim keys mean a retry is not a
                // duplicate, and an operator who believes otherwise will not
                // press the button when they should.
                description="已成功的渠道不会重复发送，只会重试失败的那些。"
                invalidate={[notificationAdminLogList]}
                onSuccess={(result) =>
                  tellOutcome(
                    queuedRetryOutcome({
                      succeeded: result.succeeded,
                      message: result.message,
                      status: result.log.status,
                      lastErrorSummary: result.log.lastErrorSummary,
                    }),
                  )
                }
                permission="notification:log:handle"
                buttonProps={{ type: 'link', size: 'small', disabled: row.status === 'done' }}
              >
                重试
              </ConfirmButton>
            ),
          },
        ]}
      />
    </PageContainer>
  );
}
