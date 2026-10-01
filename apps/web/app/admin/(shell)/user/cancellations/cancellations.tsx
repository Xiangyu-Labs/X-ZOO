'use client';

import { Alert, Button, Typography } from 'antd';
import { useState } from 'react';
import { z } from 'zod';
import {
  userAdminApproveCancellation,
  userAdminCancellationList,
  userAdminRejectCancellation,
  userAdminRemarkCancellation,
} from '@shop/contracts/user/user.admin.contract';
import { cancellationReviewBody, type CancellationRequest } from '@shop/contracts/user/schemas';

import { ModalForm } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { statusOptions } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

import { CANCELLATION_STATUS } from '../user-enums';

type Decision = 'approve' | 'reject' | 'remark';

/**
 * 注销申请.
 *
 * Approving is irreversible and is spelled out in the dialog: the account is
 * anonymised and every session ends, but the row stays, because orders, refunds
 * and invoices point at that id and a hard delete would either take a
 * customer's purchase history with it or fail on a foreign key at 2am.
 *
 * The nickname and phone shown here are the frozen copies taken when the
 * request was filed — after approval the `users` row no longer has them, and a
 * reviewer looking at last month's list would otherwise see only an id.
 */
export function CancellationsPage() {
  const [open, setOpen] = useState<{ row: CancellationRequest; decision: Decision } | null>(null);

  return (
    <PageContainer subTitle="用户在 App 内提交的账号注销申请；通过后账号会被匿名化且无法恢复">
      <CrudTable
        route={userAdminCancellationList}
        scrollX={1200}
        filters={[
          { kind: 'text', name: 'keyword', label: '关键词', placeholder: '昵称或手机号' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            options: statusOptions(CANCELLATION_STATUS),
          },
        ]}
        columns={[
          idColumn<CancellationRequest>({ sortable: true }),
          textColumn<CancellationRequest>({ title: '用户 ID', dataIndex: 'userId', width: 100 }),
          textColumn<CancellationRequest>({ title: '昵称', dataIndex: 'nickname', ellipsis: true }),
          textColumn<CancellationRequest>({ title: '手机号', dataIndex: 'phone', width: 130 }),
          textColumn<CancellationRequest>({ title: '原因', dataIndex: 'reason', ellipsis: true }),
          enumColumn<CancellationRequest, CancellationRequest['status']>({
            title: '状态',
            dataIndex: 'status',
            map: CANCELLATION_STATUS,
          }),
          textColumn<CancellationRequest>({
            title: '审核备注',
            dataIndex: 'reviewRemark',
            ellipsis: true,
          }),
          instantColumn<CancellationRequest>({ title: '审核时间', dataIndex: 'reviewedAt' }),
          instantColumn<CancellationRequest>({
            title: '申请时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<CancellationRequest>({
            width: 190,
            render: (row) => (
              <Can permission="user:cancellation:review">
                {row.status === 'pending' ? (
                  <>
                    <Button
                      type="link"
                      size="small"
                      danger
                      onClick={() => setOpen({ row, decision: 'approve' })}
                    >
                      通过
                    </Button>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setOpen({ row, decision: 'reject' })}
                    >
                      拒绝
                    </Button>
                  </>
                ) : null}
                <Button
                  type="link"
                  size="small"
                  onClick={() => setOpen({ row, decision: 'remark' })}
                >
                  备注
                </Button>
              </Can>
            ),
          }),
        ]}
      />

      <ReviewModal state={open} onClose={() => setOpen(null)} />
    </PageContainer>
  );
}

const COPY: Record<Decision, { title: string; ok: string; success: string; hint: string }> = {
  approve: {
    title: '通过注销申请',
    ok: '确认通过',
    success: '已通过',
    hint: '账号将被匿名化：账号名、手机号、昵称、头像、真实姓名与备注全部清空，所有登录态立即失效。历史订单会保留，但无法恢复该账号。',
  },
  reject: {
    title: '拒绝注销申请',
    ok: '确认拒绝',
    success: '已拒绝',
    hint: '用户可以重新提交申请。建议在备注里写明原因，客服会看到。',
  },
  remark: {
    title: '添加备注',
    ok: '保存备注',
    success: '已保存',
    hint: '只记录一条备注，不改变申请状态。',
  },
};

/** A 备注 on its own must say something; the route alone would take `''`. */
const remarkForm = z.object({ remark: z.string().trim().min(1).max(255) });

function ReviewModal({
  state,
  onClose,
}: {
  state: { row: CancellationRequest; decision: Decision } | null;
  onClose: () => void;
}) {
  // Closing clears `state` while the dialog fades out; it keeps showing the
  // request it was opened on rather than turning into 添加备注 on the way.
  const [shown, setShown] = useState(state);
  if (state !== null && state !== shown) setShown(state);
  const row = shown?.row;
  const decision = shown?.decision ?? 'remark';
  const copy = COPY[decision];
  const params = { id: row?.id ?? '' };

  const shared = {
    open: state !== null,
    onClose,
    title: copy.title,
    size: 'small',
    okText: copy.ok,
    header: (
      <>
        <Typography.Paragraph>
          用户 <Typography.Text strong>{row?.nickname ?? row?.userId}</Typography.Text>（
          {row?.phone ?? '无手机号'}）的申请
          {row?.reason ? `：${row.reason}` : ''}
        </Typography.Paragraph>
        <Alert
          type={decision === 'approve' ? 'warning' : 'info'}
          showIcon
          message={copy.hint}
          style={{ marginBottom: 12 }}
        />
      </>
    ),
    invalidate: [userAdminCancellationList],
    successMessage: copy.success,
  } as const;

  if (decision === 'remark') {
    return (
      <ModalForm
        {...shared}
        schema={remarkForm}
        fields={[{ kind: 'textarea', name: 'remark', label: '备注', rows: 3 }]}
        route={userAdminRemarkCancellation}
        toInput={(values) => ({ params, body: values })}
      />
    );
  }
  return (
    <ModalForm
      {...shared}
      okDanger={decision === 'approve'}
      schema={cancellationReviewBody}
      fields={[
        {
          kind: 'textarea',
          name: 'remark',
          label: '审核备注',
          rows: 3,
          placeholder: '可留空',
        },
      ]}
      route={decision === 'approve' ? userAdminApproveCancellation : userAdminRejectCancellation}
      toInput={(values) => ({ params, body: values })}
    />
  );
}
