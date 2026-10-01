'use client';

import { Typography, message } from 'antd';
import {
  couponAdminList,
  couponAdminRevokeUserCoupon,
  couponAdminUserCouponList,
} from '@shop/contracts/coupon/coupon.admin.contract';
import type { AdminUserCoupon } from '@shop/contracts/coupon/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { PageContainer } from '@/admin/kit/page-container';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { USER_COUPON_SOURCE, USER_COUPON_STATUS } from '../coupon-enums';

/**
 * 已领取记录.
 *
 * Support looks a coupon up by customer or by campaign, so those are the
 * filters. The amounts are the wallet row's snapshot, not the template's
 * current values: that is the point of snapshotting them, and an answer quoting
 * an edited template would be wrong.
 *
 * The one write is 作废, the inverse of 发放: only on a coupon the console
 * handed out and nobody has spent. A gift belongs to its order's refund and a
 * claimed coupon to the shopper, so neither offers it.
 */
export function UserCouponsPage() {
  return (
    <PageContainer subTitle="每一张已发出的优惠券；金额是领取时的快照">
      <CrudTable
        route={couponAdminUserCouponList}
        scrollX={1200}
        filters={[
          { kind: 'number', name: 'userId', label: '用户 ID' },
          { kind: 'number', name: 'templateId', label: '优惠券 ID' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: Object.entries(USER_COUPON_STATUS).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
        ]}
        columns={[
          idColumn<AdminUserCoupon>({ sortable: true }),
          textColumn<AdminUserCoupon>({ title: '名称', dataIndex: 'title', ellipsis: true }),
          {
            title: '用户',
            key: 'user',
            width: 160,
            render: (_value: unknown, row: AdminUserCoupon) => (
              <Typography.Text>
                {row.userNickname ?? '—'}
                <Typography.Text type="secondary"> #{row.userId}</Typography.Text>
              </Typography.Text>
            ),
          },
          moneyColumn<AdminUserCoupon>({ title: '面额', dataIndex: 'discountAmount' }),
          moneyColumn<AdminUserCoupon>({ title: '门槛', dataIndex: 'minSpend' }),
          enumColumn<AdminUserCoupon, AdminUserCoupon['status']>({
            title: '状态',
            dataIndex: 'status',
            map: USER_COUPON_STATUS,
          }),
          enumColumn<AdminUserCoupon, AdminUserCoupon['sourceKind']>({
            title: '来源',
            dataIndex: 'sourceKind',
            map: USER_COUPON_SOURCE,
          }),
          instantColumn<AdminUserCoupon>({
            title: '领取时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          instantColumn<AdminUserCoupon>({
            title: '有效期至',
            dataIndex: 'validTo',
            sortable: true,
          }),
          instantColumn<AdminUserCoupon>({ title: '使用时间', dataIndex: 'usedAt' }),
          actionsColumn<AdminUserCoupon>({
            width: 90,
            render: (row) =>
              row.sourceKind === 'admin_grant' && row.status === 'unused' ? (
                <ConfirmButton
                  route={couponAdminRevokeUserCoupon}
                  input={{ params: { id: row.id } }}
                  title={`作废「${row.title}」？`}
                  description="作废后用户将无法使用这张券，库存归还。"
                  okText="作废"
                  invalidate={[couponAdminUserCouponList, couponAdminList]}
                  onSuccess={(result) => {
                    if (result.revoked === 1) void message.success('已作废');
                    else void message.warning('这张券已被使用或已作废，未作废');
                  }}
                  permission="coupon:grant:write"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  作废
                </ConfirmButton>
              ) : null,
          }),
        ]}
      />
    </PageContainer>
  );
}
