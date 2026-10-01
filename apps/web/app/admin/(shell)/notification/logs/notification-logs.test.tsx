import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  notificationAdminLogList,
  notificationAdminLogRetry,
} from '@shop/contracts/notification/notification.admin.contract';
import { notificationLogExample, type NotificationLog } from '@shop/contracts/notification/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { NotificationLogsPage } from './notification-logs';

/**
 * 渠道 says what each channel did. A finished row whose SMS never went out must
 * read 短信 未发出, with the reason on hover — not 已发送 because the event
 * supports SMS.
 */

const finished: NotificationLog = {
  ...(notificationLogExample as NotificationLog),
  id: '9002',
  subject: 'order:2048',
  status: 'done',
  attempts: 1,
  lastError: null,
  channels: [
    { channel: 'inApp', outcome: 'sent', note: null },
    { channel: 'wechatOa', outcome: 'skipped', note: '该渠道没有开启' },
    { channel: 'sms', outcome: 'skipped', note: '没有配置短信服务商（系统设置 → 短信）' },
    {
      channel: 'wechatMini',
      outcome: 'unknown',
      note: '这条记录较早，没有逐渠道的发送结果，无法确认是否送达',
    },
  ],
};

const queued: NotificationLog = {
  ...finished,
  id: '9003',
  subject: 'order:4096',
  status: 'pending',
  attempts: 0,
  channels: [],
};

afterEach(() => {
  resetApiConfig();
});

const reader = { ...testIdentity, permissions: ['notification:log:read'] };
const handler = {
  ...testIdentity,
  permissions: ['notification:log:read', 'notification:log:handle'],
};

describe('通知发送记录', () => {
  it('shows each channel’s own outcome, and why on hover', { timeout: 20_000 }, async () => {
    stubRoutes([
      on(notificationAdminLogList, { items: [finished, queued], total: 2, page: 1, pageSize: 20 }),
    ]);
    renderAdmin(<NotificationLogsPage />, { identity: reader });

    const row = (await screen.findByText('order:2048')).closest('tr')!;
    expect(within(row).getByText('已完成')).toBeInTheDocument();
    expect(within(row).getByText('站内信 已发送')).toBeInTheDocument();
    expect(within(row).getByText('公众号 未发出')).toBeInTheDocument();
    expect(within(row).getByText('小程序 未知')).toBeInTheDocument();

    await userEvent.setup({ pointerEventsCheck: 0 }).hover(within(row).getByText('短信 未发出'));
    expect(await screen.findByText('没有配置短信服务商（系统设置 → 短信）')).toBeInTheDocument();

    const waiting = screen.getByText('order:4096').closest('tr')!;
    expect(within(waiting).getByText('尚未发送')).toBeInTheDocument();
  });

  it('says a 重试 on a record that is already queued did not queue it again', async () => {
    const parked: NotificationLog = { ...finished, status: 'unknown', subject: 'order:8192' };
    stubRoutes([
      on(notificationAdminLogList, { items: [parked], total: 1, page: 1, pageSize: 20 }),
      on(notificationAdminLogRetry, {
        log: { ...parked, status: 'pending' },
        succeeded: false,
        message: '该发送记录已经在排队执行中，不需要再重试',
      }),
    ]);
    renderAdmin(<NotificationLogsPage />, { identity: handler });
    await screen.findByText('order:8192');

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    const ask = await screen.findByText('重新发送该通知？');
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: /确\s*定/ }));

    expect(await screen.findByText('该发送记录已经在排队执行中，不需要再重试')).toBeInTheDocument();
    expect(screen.queryByText('已重新排队')).not.toBeInTheDocument();
  });
});
