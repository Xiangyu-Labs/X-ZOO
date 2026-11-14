'use client';

import { Button, Descriptions, Drawer, Tag, Typography } from 'antd';
import { useState } from 'react';
import { systemAuditLogList } from '@shop/contracts/system/system.settings.contract';
import type { AuditLogItem } from '@shop/contracts/system/schemas';

import { InstantText } from '@/admin/kit/instant-text';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

/** The request method in words, for the 类型 filter. */
const METHOD_LABEL: Record<string, string> = {
  GET: '查看、导出',
  POST: '新建、提交',
  PUT: '修改',
  PATCH: '修改',
  DELETE: '删除',
};

/**
 * 操作日志.
 *
 * Read-only by design: there is no delete button and no route behind one. The
 * log is pruned on a schedule by `system.pruneAuditLogs`, which is a retention
 * policy an operator sets in 系统设置, not a button somebody can reach for after
 * a mistake.
 *
 * Every column is in words: the operation is its route's 中文 name and the
 * target reads 商品 #12 (both resolved by the server); the route id, the path
 * and the method are under 技术信息 in 详情, for whoever investigates.
 *
 * Writes are recorded whether they succeeded or failed, and so is any request
 * that broke (服务器开小差) — with the message the person saw and, for a
 * breakage, a 技术信息 line for whoever investigates. Reads are not, unless the
 * handler names one (an export). The stored payload has already been redacted —
 * a password field never reaches this table. Console admins write here, and
 * every admin sign-in attempt is a row too. Rows from
 * before the cutover may also name a 店员 (the deleted mobile staff console);
 * the 店员 filter stays so those still read back.
 */
export function AuditLogsPage() {
  const [viewing, setViewing] = useState<AuditLogItem | null>(null);

  return (
    <PageContainer subTitle="后台的写操作记录，失败的也在；只读，按设置的保留天数自动清理">
      <CrudTable
        route={systemAuditLogList}
        scrollX={1200}
        filters={[
          { kind: 'text', name: 'keyword', label: '关键词', placeholder: '操作名称、对象' },
          {
            kind: 'select',
            name: 'actorKind',
            label: '操作人类型',
            options: [
              { value: 'admin', label: '后台管理员' },
              { value: 'staff', label: '店员' },
            ],
          },
          { kind: 'text', name: 'adminId', label: '管理员 ID' },
          { kind: 'text', name: 'userId', label: '店员用户 ID' },
          {
            kind: 'select',
            name: 'method',
            label: '类型',
            options: (['GET', 'POST', 'PUT', 'DELETE'] as const).map((value) => ({
              value,
              label: METHOD_LABEL[value] ?? value,
            })),
          },
          {
            kind: 'select',
            name: 'outcome',
            label: '结果',
            options: [
              { value: 'succeeded', label: '成功' },
              { value: 'failed', label: '失败' },
            ],
          },
          { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '时间' },
        ]}
        columns={[
          idColumn<AuditLogItem>({ sortable: true }),
          instantColumn<AuditLogItem>({
            title: '时间',
            dataIndex: 'createdAt',
            sortable: true,
            width: 180,
          }),
          {
            title: '操作人',
            key: 'adminAccount',
            width: 240,
            ellipsis: true,
            render: (_value: unknown, row: AuditLogItem) => <ActorText row={row} />,
          },
          textColumn<AuditLogItem>({ title: '操作', dataIndex: 'operation', ellipsis: true }),
          textColumn<AuditLogItem>({
            title: '对象',
            dataIndex: 'targetText',
            width: 180,
            ellipsis: true,
          }),
          {
            title: '结果',
            key: 'status',
            width: 240,
            ellipsis: true,
            render: (_value: unknown, row: AuditLogItem) => <OutcomeText row={row} />,
          },
          actionsColumn<AuditLogItem>({
            width: 90,
            render: (row) => (
              <Button type="link" size="small" onClick={() => setViewing(row)}>
                详情
              </Button>
            ),
          }),
        ]}
      />

      <Drawer
        open={viewing !== null}
        onClose={() => setViewing(null)}
        width={640}
        title={viewing ? viewing.operation : '日志详情'}
      >
        {viewing && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="时间">
              <InstantText value={viewing.createdAt} />
            </Descriptions.Item>
            <Descriptions.Item label="操作人">
              <ActorText row={viewing} />
              {viewing.adminId !== null && `（#${viewing.adminId}）`}
            </Descriptions.Item>
            <Descriptions.Item label="对象">{viewing.targetText ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="结果">
              <OutcomeText row={viewing} />
            </Descriptions.Item>
            <Descriptions.Item label="技术信息（排查用）">
              <Typography.Paragraph
                style={{ marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              >
                {technicalLines(viewing).join('\n')}
              </Typography.Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label="IP">{viewing.ip ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="请求编号">
              <Typography.Text copyable>{viewing.requestId}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="请求内容">
              <Typography.Paragraph
                style={{ marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              >
                {prettyPayload(viewing.payload)}
              </Typography.Paragraph>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </PageContainer>
  );
}

/** What a developer needs to find the request: the call, the target as stored, and on a failure what was answered. */
function technicalLines(row: AuditLogItem): string[] {
  return [
    `${row.method} ${row.path}（${row.routeId}）`,
    ...(row.target === null ? [] : [`对象：${row.target}`]),
    ...(row.errorCode === null ? [] : [`${row.status} ${row.errorCode}`]),
    ...(row.errorDetail === null ? [] : [row.errorDetail]),
  ];
}

/** 成功, or 失败 with the message the person was shown. */
function OutcomeText({ row }: { row: AuditLogItem }) {
  if (row.status < 400) return <Tag color="success">成功</Tag>;
  return (
    <>
      <Tag color="error">失败</Tag>
      {row.errorMessage}
    </>
  );
}

/** Who acted: a console account, a 店员 (by storefront user id), or a sign-in to an unknown account. */
function ActorText({ row }: { row: AuditLogItem }) {
  if (row.actorKind === 'staff') {
    return (
      <>
        <Tag color="purple">店员</Tag>
        {row.userId === null ? (
          <Typography.Text type="secondary">（用户已删除）</Typography.Text>
        ) : (
          `用户 #${row.userId}`
        )}
      </>
    );
  }
  return (
    <>
      {row.adminAccount}
      {row.adminId === null && (
        <Typography.Text type="secondary">
          {row.routeId === 'auth.adminLogin' ? ' （未知账号）' : ' （已删除）'}
        </Typography.Text>
      )}
      {row.apiTokenId !== null && (
        <Tag color="blue" style={{ marginLeft: 6 }} title={row.apiTokenName ?? '令牌已删除'}>
          AI/令牌{row.apiTokenName ? `：${row.apiTokenName}` : ''}
        </Tag>
      )}
    </>
  );
}

/**
 * The payload is stored as text, already redacted. Pretty-print it when it
 * parses and show it verbatim when it does not — a log viewer that throws on
 * malformed history is worse than one that shows the history.
 */
function prettyPayload(payload: string | null): string {
  if (!payload) return '—';
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
