'use client';

import { Alert, Button, Card, Descriptions, Tag, Typography } from 'antd';
import {
  paymentMiniTradeStatus,
  paymentMiniTradeSync,
} from '@shop/contracts/payment/payment.mini-trade.contract';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { InstantText } from '@/admin/kit/instant-text';
import { useCan } from '@/admin/session/session-provider';

/**
 * 小程序发货信息管理 — what WeChat was last told, and the 同步 button.
 *
 * 同步 is an operator's action on purpose, not a side effect of saving the form
 * above: it needs the mini program's AppID and AppSecret in place, and WeChat's
 * answer (已纳入 / 未纳入, or a refusal) is something the operator has to read.
 */
export function MiniTradePanel() {
  // Both routes are `payment:config:write`, a different atom from the
  // settings group's own read. Without it the card would only be a failed
  // query and a 同步 that answers 403, so a reader gets no card at all.
  const mayWrite = useCan()('payment:config:write');
  const status = useRouteQuery(paymentMiniTradeStatus, {}, { enabled: mayWrite });
  const sync = useRouteMutation(paymentMiniTradeSync, {
    invalidate: [paymentMiniTradeStatus],
    successMessage: '已同步',
  });
  const data = status.data;
  const stale = data !== undefined && data.msgJumpPath !== data.expectedMsgJumpPath;

  if (!mayWrite) return null;

  return (
    <Card
      title="微信侧状态"
      loading={status.isPending}
      extra={
        <Button type="primary" loading={sync.isPending} onClick={() => sync.mutate({})}>
          同步
        </Button>
      }
    >
      {data ? (
        <>
          {stale ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="消息跳转路径尚未设置或已过期，请点击「同步」"
            />
          ) : null}
          <Descriptions column={1} size="small">
            <Descriptions.Item label="已纳入发货信息管理">
              {data.managed === null ? (
                <Tag>未查询</Tag>
              ) : data.managed ? (
                <Tag color="orange">已纳入（货款在确认收货后结算）</Tag>
              ) : (
                <Tag color="green">未纳入</Tag>
              )}
              {data.managedCheckedAt ? (
                <Typography.Text type="secondary">
                  {' '}
                  查询于 <InstantText value={data.managedCheckedAt} />
                </Typography.Text>
              ) : null}
            </Descriptions.Item>
            <Descriptions.Item label="消息跳转路径">
              <Typography.Text code>{data.msgJumpPath ?? '未设置'}</Typography.Text>
              {data.msgJumpPathSetAt ? (
                <Typography.Text type="secondary">
                  {' '}
                  设置于 <InstantText value={data.msgJumpPathSetAt} />
                </Typography.Text>
              ) : null}
            </Descriptions.Item>
          </Descriptions>
        </>
      ) : null}
    </Card>
  );
}
