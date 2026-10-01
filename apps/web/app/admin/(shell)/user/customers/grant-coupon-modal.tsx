'use client';

import { Form, Modal, Select, Space, Typography, message } from 'antd';
import { useDeferredValue, useState } from 'react';
import {
  couponAdminGrant,
  couponAdminGrantBatch,
  couponAdminList,
  couponAdminUserCouponList,
} from '@shop/contracts/coupon/coupon.admin.contract';
import type { CouponGrantResult } from '@shop/contracts/coupon/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import type { BodyInputOf } from '@/admin/api/call-route';

/** Who the coupon goes to: the ticked rows, or everyone the filters match. */
export type GrantTarget =
  | { kind: 'users'; userIds: string[] }
  | {
      kind: 'filter';
      filter: BodyInputOf<typeof couponAdminGrantBatch>['filter'];
      matched: number;
    };

/**
 * 发优惠券 from the 客户列表.
 *
 * The operator picks a 进行中 coupon; the audience was chosen on the list
 * (ticked rows, or the current filters). The server resolves a filter again
 * when the grant runs, so the count shown here is what the list said, and the
 * toast reports what the server actually issued.
 */
export function GrantCouponModal({
  target,
  onClose,
  onGranted,
}: {
  target: GrantTarget | null;
  onClose: () => void;
  onGranted?: (() => void) | undefined;
}) {
  const [templateId, setTemplateId] = useState<string | undefined>();
  // 发放 pressed with no coupon chosen: said under the select, not in a toast.
  const [missing, setMissing] = useState(false);
  const [keyword, setKeyword] = useState('');
  const deferredKeyword = useDeferredValue(keyword);

  const templates = useRouteQuery(
    couponAdminList,
    {
      query: {
        page: 1,
        pageSize: 50,
        status: 'active',
        ...(deferredKeyword ? { keyword: deferredKeyword } : {}),
      },
    },
    { enabled: target !== null },
  );
  const invalidate = [couponAdminList, couponAdminUserCouponList];
  const byIds = useRouteMutation(couponAdminGrant, { invalidate });
  const byFilter = useRouteMutation(couponAdminGrantBatch, { invalidate });
  const pending = byIds.isPending || byFilter.isPending;

  const close = () => {
    setTemplateId(undefined);
    setKeyword('');
    setMissing(false);
    onClose();
  };

  const count =
    target === null ? 0 : target.kind === 'users' ? target.userIds.length : target.matched;
  const chosen = templates.data?.items.find((item) => item.id === templateId);

  const report = (result: CouponGrantResult) => {
    const skipped = result.skippedUserIds.length;
    if (result.granted === 0) {
      void message.warning('没有发出新券：所选用户都已达到每人限领数量');
    } else if (skipped > 0) {
      void message.success(`已发放 ${result.granted} 张，${skipped} 位用户已达上限`);
    } else {
      void message.success(`已发放 ${result.granted} 张`);
    }
    onGranted?.();
    close();
  };

  const submit = async () => {
    if (!target) return;
    if (!templateId) {
      setMissing(true);
      return;
    }
    const params = { id: templateId };
    try {
      report(
        target.kind === 'users'
          ? await byIds.mutateAsync({ params, body: { userIds: target.userIds } })
          : await byFilter.mutateAsync({ params, body: { filter: target.filter } }),
      );
    } catch {
      // The global presenter already showed the refusal; keep the dialog open.
    }
  };

  return (
    <Modal
      open={target !== null}
      title="发优惠券"
      okText="发放"
      confirmLoading={pending}
      onCancel={close}
      onOk={() => submit()}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Form.Item
          label="优惠券"
          required
          layout="vertical"
          style={{ marginBottom: 0 }}
          {...(missing ? { validateStatus: 'error' as const, help: '请选择优惠券' } : {})}
        >
          <Select
            showSearch
            allowClear
            style={{ width: '100%' }}
            placeholder="搜索并选择进行中的优惠券"
            aria-label="优惠券"
            value={templateId}
            onChange={(value: string | undefined) => {
              setTemplateId(value);
              setMissing(false);
            }}
            onSearch={setKeyword}
            filterOption={false}
            loading={templates.isFetching}
            notFoundContent={templates.isFetching ? '加载中…' : '没有进行中的优惠券'}
            options={(templates.data?.items ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
          />
        </Form.Item>
        {chosen ? (
          <Typography.Text type="secondary">
            {chosen.isUnlimitedSupply ? '库存不限' : `剩余 ${chosen.remainingCount ?? 0} 张`}
            {chosen.perUserLimit === null ? '，每人不限' : `，每人限 ${chosen.perUserLimit} 张`}
          </Typography.Text>
        ) : null}
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {target?.kind === 'filter' ? '将按当前筛选条件，' : '将'}向{' '}
          <Typography.Text strong>{count}</Typography.Text>{' '}
          位用户各发放一张，发放后用户立即可在「我的优惠券」看到。
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          已达每人限领数量的用户会跳过；库存不足时整批不发放。发错可在 优惠券 → 已领取记录 里作废。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
